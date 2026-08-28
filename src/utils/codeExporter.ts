import * as prettier from "prettier/standalone";
import type { Point, Line, BasePoint, SequenceItem } from "../types";

import { FIELD_SIZE as FIELD_WIDTH_INCHES } from "../config/defaults";

interface ExportTransformOptions {
  mirrorHorizontally?: boolean;
}

interface ExportPathGroup {
  id: string;
  name: string;
  color: string;
  lineIds: string[];
}

function transformX(x: number, options: ExportTransformOptions): number {
  if (!options.mirrorHorizontally) return x;
  return FIELD_WIDTH_INCHES - x;
}

function transformHeadingDegrees(
  deg: number,
  options: ExportTransformOptions,
): number {
  if (!options.mirrorHorizontally) return deg;
  return 180 - deg;
}

let cachedJavaPlugin: any | null = null;
let cachedKotlinPlugin: any | null = null;

async function loadJavaPlugin() {
  if (cachedJavaPlugin !== null) return cachedJavaPlugin;
  for (const path of ["prettier/plugins/java.js", "prettier/plugins/java"]) {
    try {
      const mod = await import(/* @vite-ignore */ path);
      cachedJavaPlugin = (mod as any).default ?? mod;
      return cachedJavaPlugin;
    } catch {
      // Try the next candidate specifier.
    }
  }
  cachedJavaPlugin = null;
  return null;
}

async function loadKotlinPlugin() {
  if (cachedKotlinPlugin !== null) return cachedKotlinPlugin;
  for (const path of ["prettier-plugin-kotlin"]) {
    try {
      const mod = await import(/* @vite-ignore */ path);
      cachedKotlinPlugin = (mod as any).default ?? mod;
      return cachedKotlinPlugin;
    } catch {
      // Try the next candidate specifier.
    }
  }
  cachedKotlinPlugin = null;
  return null;
}

function sanitizeIdentifier(
  input: string | undefined,
  fallback: string,
): string {
  const cleaned = (input || "").replace(/[^a-zA-Z0-9]/g, "");
  if (!cleaned) return fallback;
  if (/^[0-9]/.test(cleaned)) return `${fallback}${cleaned}`;
  return cleaned;
}

function camelCase(str: string): string {
  if (!str) return str;
  return str.charAt(0).toLowerCase() + str.slice(1);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Number(value.toFixed(4));
  return Number.isInteger(rounded) ? rounded.toString() : rounded.toString();
}

function normalizeCompoundPaths(
  lines: (Line & { id: string })[],
): ExportPathGroup[] {
  return lines
    .map((line, idx) => ({
      id: line.id,
      name: line.name || `Path${idx + 1}`,
      color: line.color || "#22c55e",
      lineIds: [line.id],
    }))
    .filter((compoundPath) => compoundPath.lineIds.length > 0);
}
function getStartVarName(
  lineIdx: number,
  linesWithIds: (Line & { id: string })[],
  startPoint?: Point,
): string {
  if (lineIdx <= 0) {
    return camelCase(sanitizeIdentifier(startPoint?.name, "start"));
  }
  const prevLine = linesWithIds[lineIdx - 1];
  return camelCase(sanitizeIdentifier(prevLine.name, `point${lineIdx}`));
}

function getEndVarName(line: Line & { id: string }, lineIdx: number): string {
  return camelCase(sanitizeIdentifier(line.name, `point${lineIdx + 1}`));
}

function getPoseHeading(ep: Point, options: ExportTransformOptions): number {
  if (ep.heading === "constant") {
    return transformHeadingDegrees(ep.degrees ?? 0, options);
  }
  if (ep.heading === "linear") {
    return transformHeadingDegrees(ep.endDeg ?? 0, options);
  }
  if (ep.heading === "tangential") {
    return 0;
  }
  return 0;
}

function getStartPoseHeading(
  lineIdx: number,
  linesWithIds: (Line & { id: string })[],
  startPoint: Point,
  options: ExportTransformOptions,
): number {
  if (lineIdx <= 0) {
    const firstLine = linesWithIds[0];
    if (!firstLine) return 0;
    const ep = firstLine.endPoint;
    if (ep.heading === "linear") {
      return transformHeadingDegrees(ep.startDeg ?? 0, options);
    }
    return 0;
  }
  return getPoseHeading(linesWithIds[lineIdx - 1].endPoint, options);
}

function buildHeadingInterpolation(
  line: Line & { id: string },
  startVarName: string,
  endVarName: string,
): string {
  const ep = line.endPoint;
  switch (ep.heading) {
    case "constant":
      return `.constant(${startVarName})`;
    case "linear":
      return `.linear(${startVarName}, ${endVarName})`;
    case "tangential":
      return "";
    default:
      return "";
  }
}

function buildPathExpression(
  line: Line & { id: string },
  lineIdx: number,
  linesWithIds: (Line & { id: string })[],
  startPoint?: Point,
): string {
  const startVar = getStartVarName(lineIdx, linesWithIds, startPoint);
  const endVar = getEndVarName(line, lineIdx);
  const heading = buildHeadingInterpolation(line, startVar, endVar);

  if (line.controlPoints.length === 0) {
    return `line(${startVar}, ${endVar})${heading}`;
  }

  const controlVars = line.controlPoints
    .map((_, cpIdx) => `${endVar}Control${cpIdx + 1}`)
    .join(", ");
  return `curve(${startVar}, ${controlVars}, ${endVar})${heading}`;
}

// Generates inline declared Java Pose fields
function javaPoseFieldsInline(
  startPoint: Point,
  linesWithIds: (Line & { id: string })[],
  compoundPaths: ExportPathGroup[],
  options: ExportTransformOptions,
  mirrorHorizontally: boolean,
): string {
  const lines: string[] = [];
  const usedLineIds = new Set(compoundPaths.flatMap((c) => c.lineIds));
  const mirrorCall = mirrorHorizontally
    ? `.mirrorX(${FIELD_WIDTH_INCHES / 2})`
    : "";

  lines.push(
    `    private final PoseFactory p = PoseFactory.degrees()${mirrorCall};`,
  );
  lines.push("");

  const startName = camelCase(sanitizeIdentifier(startPoint.name, "start"));
  const startHeading = getStartPoseHeading(
    0,
    linesWithIds,
    startPoint,
    options,
  );
  lines.push(
    `    private final Pose ${startName} = p.of(${formatNumber(transformX(startPoint.x, options))}, ${formatNumber(startPoint.y)}, ${formatNumber(startHeading)});`,
  );

  linesWithIds.forEach((line, lineIdx) => {
    if (!usedLineIds.has(line.id)) return;

    const endName = getEndVarName(line, lineIdx);
    const ep = line.endPoint;
    const heading = getPoseHeading(ep, options);

    lines.push(
      `    private final Pose ${endName} = p.of(${formatNumber(transformX(ep.x, options))}, ${formatNumber(ep.y)}, ${formatNumber(heading)});`,
    );

    line.controlPoints.forEach((cp, cpIdx) => {
      const cpName = `${endName}Control${cpIdx + 1}`;
      lines.push(
        `    private final Pose ${cpName} = p.of(${formatNumber(transformX(cp.x, options))}, ${formatNumber(cp.y)}, 0);`,
      );
    });
  });

  return lines.join("\n");
}

// Generates inline declared Kotlin Pose fields
function kotlinPoseFieldsInline(
  startPoint: Point,
  linesWithIds: (Line & { id: string })[],
  compoundPaths: ExportPathGroup[],
  options: ExportTransformOptions,
  mirrorHorizontally: boolean,
): string {
  const lines: string[] = [];
  const usedLineIds = new Set(compoundPaths.flatMap((c) => c.lineIds));
  const mirrorCall = mirrorHorizontally
    ? `.mirrorX(${FIELD_WIDTH_INCHES / 2})`
    : "";

  lines.push(`    private val p = PoseFactory.degrees()${mirrorCall}`);
  lines.push("");

  const startName = camelCase(sanitizeIdentifier(startPoint.name, "start"));
  const startHeading = getStartPoseHeading(
    0,
    linesWithIds,
    startPoint,
    options,
  );
  lines.push(
    `    private val ${startName} = p.of(${formatNumber(transformX(startPoint.x, options))}, ${formatNumber(startPoint.y)}, ${formatNumber(startHeading)})`,
  );

  linesWithIds.forEach((line, lineIdx) => {
    if (!usedLineIds.has(line.id)) return;

    const endName = getEndVarName(line, lineIdx);
    const ep = line.endPoint;
    const heading = getPoseHeading(ep, options);

    lines.push(
      `    private val ${endName} = p.of(${formatNumber(transformX(ep.x, options))}, ${formatNumber(ep.y)}, ${formatNumber(heading)})`,
    );

    line.controlPoints.forEach((cp, cpIdx) => {
      const cpName = `${endName}Control${cpIdx + 1}`;
      lines.push(
        `    private val ${cpName} = p.of(${formatNumber(transformX(cp.x, options))}, ${formatNumber(cp.y)}, 0.0)`,
      );
    });
  });

  return lines.join("\n");
}

// Java path methods - each compound path becomes a method
function javaPathMethods(
  compoundPaths: ExportPathGroup[],
  linesWithIds: (Line & { id: string })[],
  _options: ExportTransformOptions,
  startPoint?: Point,
): string {
  return compoundPaths
    .map((compound, compoundIdx) => {
      const methodName = camelCase(
        sanitizeIdentifier(compound.name, `path${compoundIdx + 1}`),
      );

      if (compound.lineIds.length === 1) {
        // Atomic path (single line/curve)
        const lineId = compound.lineIds[0];
        const lineIdx = linesWithIds.findIndex((ln) => ln.id === lineId);
        const line = linesWithIds[lineIdx];
        if (!line) return "";
        const expr = buildPathExpression(
          line,
          lineIdx,
          linesWithIds,
          startPoint,
        );
        return `    public Path ${methodName}() {\n        return ${expr};\n    }`;
      }

      // Compound path (multiple paths grouped together)
      const pathExprs = compound.lineIds
        .map((lineId) => {
          const lineIdx = linesWithIds.findIndex((ln) => ln.id === lineId);
          const line = linesWithIds[lineIdx];
          if (!line) return null;
          return buildPathExpression(line, lineIdx, linesWithIds, startPoint);
        })
        .filter((s): s is string => Boolean(s));

      return `    public Path ${methodName}() {\n        return path(\n            ${pathExprs.join(",\n            ")}\n        );\n    }`;
    })
    .join("\n\n");
}

// Kotlin path methods
function kotlinPathMethods(
  compoundPaths: ExportPathGroup[],
  linesWithIds: (Line & { id: string })[],
  _options: ExportTransformOptions,
  startPoint?: Point,
): string {
  return compoundPaths
    .map((compoundPath, compoundIdx) => {
      const fnName = camelCase(
        sanitizeIdentifier(compoundPath.name, `path${compoundIdx + 1}`),
      );

      if (compoundPath.lineIds.length === 1) {
        const lineId = compoundPath.lineIds[0];
        const lineIdx = linesWithIds.findIndex((ln) => ln.id === lineId);
        const line = linesWithIds[lineIdx];
        if (!line) return "";
        const expr = buildPathExpression(
          line,
          lineIdx,
          linesWithIds,
          startPoint,
        );
        return `    fun ${fnName}(): Path = ${expr}`;
      }

      const pathExprs = compoundPath.lineIds
        .map((lineId) => {
          const lineIdx = linesWithIds.findIndex((ln) => ln.id === lineId);
          const line = linesWithIds[lineIdx];
          if (!line) return null;
          return buildPathExpression(line, lineIdx, linesWithIds, startPoint);
        })
        .filter((s): s is string => Boolean(s));

      return `    fun ${fnName}(): Path = path(\n            ${pathExprs.join(",\n            ")}\n        )`;
    })
    .join("\n\n");
}

export async function generateJavaCode(
  startPoint: Point,
  lines: Line[],
  exportMode: "full" | "class" | "coordinates" = "class",
  mirrorHorizontally = false,
): Promise<string> {
  const options: ExportTransformOptions = { mirrorHorizontally };

  const linesWithIds = lines.map((line, idx) => ({
    ...line,
    id: line.id || `line-${idx + 1}`,
  })) as (Line & { id: string })[];

  const compoundPaths = normalizeCompoundPaths(linesWithIds);
  const startVarName = camelCase(sanitizeIdentifier(startPoint.name, "start"));

  const fields = javaPoseFieldsInline(
    startPoint,
    linesWithIds,
    compoundPaths,
    options,
    mirrorHorizontally,
  );
  const methods = javaPathMethods(
    compoundPaths,
    linesWithIds,
    options,
    startPoint,
  );

  if (exportMode === "coordinates") {
    return `${fields}\n\n${methods}`;
  }

  const pathsClass = `import static com.pedropathing.api.Paths.*;

import com.pedropathing.api.PoseFactory;
import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;

public class Paths {

${fields}

${methods}
}`;

  if (exportMode === "class") {
    try {
      const plugin = await loadJavaPlugin();
      return await prettier.format(pathsClass, {
        parser: "java",
        plugins: plugin ? [plugin] : [],
      });
    } catch {
      return pathsClass;
    }
  }

  // Full OpMode mode following Pedro Pathing Ivy autonomous structure
  const pathFollows = compoundPaths
    .map((compoundPath, idx) => {
      const name = camelCase(
        sanitizeIdentifier(compoundPath.name, `path${idx + 1}`),
      );
      return `            follow(follower, ${name}())`;
    })
    .join(",\n");

  const file = `package org.firstinspires.ftc.teamcode;

import static com.pedropathing.api.Paths.*;

import com.pedropathing.api.PoseFactory;
import com.pedropathing.follower.Follower;
import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;
import com.pedropathing.ivy.Command;
import com.pedropathing.ivy.Scheduler;
import static com.pedropathing.ivy.Scheduler.schedule;
import static com.pedropathing.ivy.commands.Commands.*;
import static com.pedropathing.ivy.groups.Groups.sequential;
import static com.pedropathing.ivy.pedro.PedroCommands.follow;
import com.qualcomm.robotcore.eventloop.opmode.Autonomous;
import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;

@Autonomous(name = "AutoOpMode", group = "Autonomous")
public class AutoOpMode extends LinearOpMode {

    private Follower follower;

${fields}

    // Autonomous routine
    public Command autoRoutine() {
        return sequential(
${pathFollows}
        );
    }

    @Override
    public void runOpMode() {
        Scheduler.reset();
        follower = Constants.create(hardwareMap);
        follower.setPose(${startVarName});
        follower.update();

        waitForStart();
        schedule(autoRoutine());

        while (opModeIsActive()) {
            follower.update();
            Scheduler.execute();

            telemetry.addData("x", follower.pose().x());
            telemetry.addData("y", follower.pose().y());
            telemetry.addData("heading", follower.pose().heading());

            if (follower.currentPath() != null) {
                telemetry.addData("Current path distance remaining", follower.distanceToEndpoint());
                telemetry.addData("Path number", follower.pathIndex());
            }

            telemetry.update();
        }
    }

${methods}
}
`;

  try {
    const plugin = await loadJavaPlugin();
    return await prettier.format(file, {
      parser: "java",
      plugins: plugin ? [plugin] : [],
    });
  } catch (error) {
    console.error("Code formatting error:", error);
    return file;
  }
}

export async function generateKotlinCode(
  startPoint: Point,
  lines: Line[],
  exportMode: "full" | "class" | "coordinates" = "class",
  mirrorHorizontally = false,
): Promise<string> {
  const options: ExportTransformOptions = { mirrorHorizontally };

  const linesWithIds = lines.map((line, idx) => ({
    ...line,
    id: line.id || `line-${idx + 1}`,
  })) as (Line & { id: string })[];

  const compoundPaths = normalizeCompoundPaths(linesWithIds);
  const startVarName = camelCase(sanitizeIdentifier(startPoint.name, "start"));

  const fields = kotlinPoseFieldsInline(
    startPoint,
    linesWithIds,
    compoundPaths,
    options,
    mirrorHorizontally,
  );
  const methods = kotlinPathMethods(
    compoundPaths,
    linesWithIds,
    options,
    startPoint,
  );

  if (exportMode === "coordinates") {
    return `${fields}\n\n${methods}`;
  }

  const pathsClass = `import com.pedropathing.api.Paths.*
import com.pedropathing.api.PoseFactory
import com.pedropathing.math.Pose
import com.pedropathing.paths.Path

class Paths {

${fields}

${methods}
}`;

  if (exportMode === "class") {
    try {
      const plugin = await loadKotlinPlugin();
      if (!plugin) return pathsClass;
      return await prettier.format(pathsClass, {
        parser: "kotlin",
        plugins: [plugin],
      });
    } catch {
      return pathsClass;
    }
  }

  // Full OpMode mode (Kotlin)
  const pathFollows = compoundPaths
    .map((compoundPath, idx) => {
      const name = camelCase(
        sanitizeIdentifier(compoundPath.name, `path${idx + 1}`),
      );
      return `            follow(follower, ${name}())`;
    })
    .join(",\n");

  const file = `package org.firstinspires.ftc.teamcode

import com.pedropathing.api.Paths.*
import com.pedropathing.api.PoseFactory
import com.pedropathing.follower.Follower
import com.pedropathing.math.Pose
import com.pedropathing.paths.Path
import com.pedropathing.ivy.Command
import com.pedropathing.ivy.Scheduler
import com.pedropathing.ivy.Scheduler.schedule
import com.pedropathing.ivy.commands.Commands.*
import com.pedropathing.ivy.groups.Groups.sequential
import com.pedropathing.ivy.pedro.PedroCommands.follow
import com.qualcomm.robotcore.eventloop.opmode.Autonomous
import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode

@Autonomous(name = "AutoOpMode", group = "Autonomous")
class AutoOpMode : LinearOpMode() {

    private lateinit var follower: Follower

${fields}

    // Autonomous routine
    fun autoRoutine(): Command = sequential(
${pathFollows}
    )

    override fun runOpMode() {
        Scheduler.reset()
        follower = Constants.create(hardwareMap)
        follower.setPose(${startVarName})
        follower.update()

        waitForStart()
        schedule(autoRoutine())

        while (opModeIsActive()) {
            follower.update()
            Scheduler.execute()

            telemetry.addData("x", follower.pose().x())
            telemetry.addData("y", follower.pose().y())
            telemetry.addData("heading", follower.pose().heading())

            if (follower.currentPath() != null) {
                telemetry.addData("Current path distance remaining", follower.distanceToEndpoint())
                telemetry.addData("Path number", follower.pathIndex())
            }

            telemetry.update()
        }
    }

${methods}
}
`;

  try {
    const plugin = await loadKotlinPlugin();
    if (!plugin) return file;
    return await prettier.format(file, {
      parser: "kotlin",
      plugins: [plugin],
    });
  } catch (error) {
    console.error("Kotlin code formatting error:", error);
    return file;
  }
}

export function generatePointsArray(startPoint: Point, lines: Line[]): string {
  const points: BasePoint[] = [startPoint];

  lines.forEach((line) => {
    line.controlPoints.forEach((cp) => points.push(cp));
    points.push(line.endPoint);
  });

  const pointsString = points
    .map((point) => {
      const x = Number.isInteger(point.x)
        ? point.x.toFixed(1)
        : point.x.toFixed(3);
      const y = Number.isInteger(point.y)
        ? point.y.toFixed(1)
        : point.y.toFixed(3);
      return `(${x}, ${y})`;
    })
    .join(", ");

  return `[${pointsString}]`;
}

export async function generateSequentialCommandCode(
  startPoint: Point,
  lines: Line[],
  fileName: string | null = null,
  sequence?: SequenceItem[],
): Promise<string> {
  let className = "AutoPath";
  if (fileName) {
    const baseName = fileName.split(/[/]/).pop() || "";
    className =
      baseName.replace(".pp", "").replace(/[^a-zA-Z0-9]/g, "_") || "AutoPath";
  }

  const options: ExportTransformOptions = { mirrorHorizontally: false };

  const linesWithIds = lines.map((line, idx) => ({
    ...line,
    id: line.id || `line-${idx + 1}`,
  })) as (Line & { id: string })[];

  const compoundPaths = normalizeCompoundPaths(linesWithIds);
  const fields = javaPoseFieldsInline(
    startPoint,
    linesWithIds,
    compoundPaths,
    options,
    false,
  );
  const methods = javaPathMethods(
    compoundPaths,
    linesWithIds,
    options,
    startPoint,
  );
  const startVarName = camelCase(sanitizeIdentifier(startPoint.name, "start"));

  const defaultSeq: SequenceItem[] = lines.map((ln, idx) => ({
    kind: "path",
    lineId: ln.id || `line-${idx + 1}`,
  }));
  const seq = sequence && sequence.length ? sequence : defaultSeq;

  const commands: string[] = [];
  seq.forEach((item) => {
    if (item.kind === "wait") {
      commands.push(`            waitMs(${(item as any).durationMs})`);
      return;
    }
    const lineIdx = linesWithIds.findIndex(
      (l) => l.id === (item as any).lineId,
    );
    if (lineIdx < 0) return;
    const name = camelCase(
      sanitizeIdentifier(linesWithIds[lineIdx].name, `path${lineIdx + 1}`),
    );
    commands.push(`            follow(follower, ${name}())`);
  });

  const file = `package org.firstinspires.ftc.teamcode;

import static com.pedropathing.api.Paths.*;

import com.pedropathing.api.PoseFactory;
import com.pedropathing.follower.Follower;
import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;
import com.pedropathing.ivy.Command;
import com.pedropathing.ivy.Scheduler;
import static com.pedropathing.ivy.Scheduler.schedule;
import static com.pedropathing.ivy.commands.Commands.*;
import static com.pedropathing.ivy.groups.Groups.sequential;
import static com.pedropathing.ivy.pedro.PedroCommands.follow;
import com.qualcomm.robotcore.eventloop.opmode.Autonomous;
import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;

@Autonomous(name = "${className}", group = "Autonomous")
public class ${className} extends LinearOpMode {

    private Follower follower;

${fields}

    // Autonomous routine
    public Command autoRoutine() {
        return sequential(
${commands.join(",\n")}
        );
    }

    @Override
    public void runOpMode() {
        Scheduler.reset();
        follower = Constants.create(hardwareMap);
        follower.setPose(${startVarName});
        follower.update();

        waitForStart();
        schedule(autoRoutine());

        while (opModeIsActive()) {
            follower.update();
            Scheduler.execute();

            telemetry.addData("x", follower.pose().x());
            telemetry.addData("y", follower.pose().y());
            telemetry.addData("heading", follower.pose().heading());

            if (follower.currentPath() != null) {
                telemetry.addData("Current path distance remaining", follower.distanceToEndpoint());
                telemetry.addData("Path number", follower.pathIndex());
            }

            telemetry.update();
        }
    }

${methods}
}
`;

  try {
    const plugin = await loadJavaPlugin();
    return await prettier.format(file, {
      parser: "java",
      plugins: plugin ? [plugin] : [],
    });
  } catch (error) {
    console.error("Code formatting error:", error);
    return file;
  }
}
