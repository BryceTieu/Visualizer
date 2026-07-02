import prettier from "prettier";
import type { Point, Line, BasePoint, PathChain } from "../types";

const FIELD_WIDTH_INCHES = 141.5;

interface ExportTransformOptions {
  mirrorHorizontally?: boolean;
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
    } catch {}
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
    } catch {}
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

// Collect every unique pose needed across all chains
function collectPoses(
  startPoint: Point,
  linesWithIds: (Line & { id: string })[],
  normalizedChains: PathChain[],
  options: ExportTransformOptions,
): Map<string, { x: number; y: number; headingRad?: number }> {
  const poses = new Map<
    string,
    { x: number; y: number; headingRad?: number }
  >();

  const startName = camelCase(sanitizeIdentifier(startPoint.name, "start"));
  poses.set(startName, {
    x: transformX(startPoint.x, options),
    y: startPoint.y,
    headingRad: 0,
  });

  const usedLineIds = new Set(normalizedChains.flatMap((c) => c.lineIds));

  linesWithIds.forEach((line, lineIdx) => {
    if (!usedLineIds.has(line.id)) return;

    const endName = camelCase(
      sanitizeIdentifier(line.name, `point${lineIdx + 1}`),
    );
    const ep = line.endPoint;
    const endHeading =
      ep.heading === "constant"
        ? (transformHeadingDegrees(ep.degrees ?? 0, options) * Math.PI) / 180
        : ep.heading === "linear"
          ? (transformHeadingDegrees(ep.endDeg ?? 0, options) * Math.PI) / 180
          : undefined;

    poses.set(endName, {
      x: transformX(ep.x, options),
      y: ep.y,
      headingRad: endHeading,
    });

    line.controlPoints.forEach((cp, cpIdx) => {
      const cpName = `${endName}Control${cpIdx + 1}`;
      poses.set(cpName, {
        x: transformX(cp.x, options),
        y: cp.y,
      });
    });
  });

  return poses;
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
function getEndVarName(
  line: Line & { id: string },
  lineIdx: number,
): string {
  return camelCase(sanitizeIdentifier(line.name, `point${lineIdx + 1}`));
}

function buildJavaSegment(
  line: Line & { id: string },
  lineIdx: number,
  linesWithIds: (Line & { id: string })[],
  options: ExportTransformOptions,
  indent: string,
  startPoint?: Point,
): string {
  const headingFn: Record<string, string> = {
    constant: "setConstantHeadingInterpolation",
    linear: "setLinearHeadingInterpolation",
    tangential: "setTangentHeadingInterpolation",
  };

  const startVar = getStartVarName(lineIdx, linesWithIds, startPoint);
  const endVar = getEndVarName(line, lineIdx);
  const curveType =
    line.controlPoints.length === 0 ? "BezierLine" : "BezierCurve";

  const pointVars: string[] = [startVar];
  line.controlPoints.forEach((_, cpIdx) => {
    pointVars.push(`${endVar}Control${cpIdx + 1}`);
  });
  pointVars.push(endVar);

  const pointsList = pointVars.join(", ");

  let headingArgs = "";
  if (line.endPoint.heading === "constant") {
    headingArgs = `Math.toRadians(${transformHeadingDegrees(line.endPoint.degrees ?? 0, options).toFixed(1)})`;
  } else if (line.endPoint.heading === "linear") {
    const startDeg = transformHeadingDegrees(
      line.endPoint.startDeg ?? 0,
      options,
    ).toFixed(1);
    const endDeg = transformHeadingDegrees(
      line.endPoint.endDeg ?? 0,
      options,
    ).toFixed(1);
    headingArgs = `Math.toRadians(${startDeg}), Math.toRadians(${endDeg})`;
  }

  const reverse = line.endPoint.reverse
    ? `\n${indent}.setReversed()`
    : "";

  return [
    `.addPath(new ${curveType}(${pointsList}))`,
    `.${headingFn[line.endPoint.heading]}(${headingArgs})${reverse}`,
  ].join(`\n${indent}`);
}

function buildKotlinSegment(
  line: Line & { id: string },
  lineIdx: number,
  linesWithIds: (Line & { id: string })[],
  options: ExportTransformOptions,
  indent: string,
  startPoint?: Point,
): string {
  const headingFn: Record<string, string> = {
    constant: "setConstantHeadingInterpolation",
    linear: "setLinearHeadingInterpolation",
    tangential: "setTangentHeadingInterpolation",
  };

  const startVar = getStartVarName(lineIdx, linesWithIds, startPoint);
  const endVar = getEndVarName(line, lineIdx);
  const curveType =
    line.controlPoints.length === 0 ? "BezierLine" : "BezierCurve";

  const pointVars: string[] = [startVar];
  line.controlPoints.forEach((_, cpIdx) => {
    pointVars.push(`${endVar}Control${cpIdx + 1}`);
  });
  pointVars.push(endVar);

  const pointsList = pointVars.join(", ");

  let headingArgs = "";
  if (line.endPoint.heading === "constant") {
    headingArgs = `Math.toRadians(${transformHeadingDegrees(line.endPoint.degrees ?? 0, options).toFixed(1)})`;
  } else if (line.endPoint.heading === "linear") {
    const startDeg = transformHeadingDegrees(
      line.endPoint.startDeg ?? 0,
      options,
    ).toFixed(1);
    const endDeg = transformHeadingDegrees(
      line.endPoint.endDeg ?? 0,
      options,
    ).toFixed(1);
    headingArgs = `Math.toRadians(${startDeg}), Math.toRadians(${endDeg})`;
  }

  const reverse = line.endPoint.reverse
    ? `\n${indent}.setReversed()`
    : "";

  return [
    `.addPath(${curveType}(${pointsList}))`,
    `.${headingFn[line.endPoint.heading]}(${headingArgs})${reverse}`,
  ].join(`\n${indent}`);
}

function normalizeChains(
  lines: (Line & { id: string })[],
  pathChains: PathChain[],
  lineById: Map<string, Line & { id: string }>,
): PathChain[] {
  const inputChains: PathChain[] =
    pathChains.length > 0
      ? pathChains
      : lines.map((line, idx) => ({
          id: line.id,
          name: line.name || `Path${idx + 1}`,
          color: "#22c55e",
          lineIds: [line.id],
        }));

  return inputChains
    .map((chain, idx) => ({
      ...chain,
      id: chain.id || `chain-${idx + 1}`,
      name: chain.name || `PathChain${idx + 1}`,
      lineIds: (chain.lineIds || []).filter((id) => lineById.has(id)),
    }))
    .filter((chain) => chain.lineIds.length > 0);
}

function javaPoseDeclarations(
  poses: Map<string, { x: number; y: number; headingRad?: number }>,
): string {
  const lines: string[] = [];

  poses.forEach((pose, name) => {
    const x = pose.x.toFixed(3);
    const y = pose.y.toFixed(3);

    if (pose.headingRad !== undefined) {
      const hdg = pose.headingRad.toFixed(4);
      lines.push(
        `    private final Pose ${name} = new Pose(${x}, ${y}, ${hdg});`,
      );
    } else {
      lines.push(
        `    private final Pose ${name} = new Pose(${x}, ${y});`,
      );
    }
  });

  return lines.join("\n");
}

function javaPathMethods(
  normalizedChains: PathChain[],
  linesWithIds: (Line & { id: string })[],
  options: ExportTransformOptions,
  startPoint?: Point,
): string {
  const indent = "            ";

  return normalizedChains
    .map((chain, chainIdx) => {
      const methodName = camelCase(
        sanitizeIdentifier(chain.name, `pathChain${chainIdx + 1}`),
      );

      const segments = chain.lineIds
        .map((lineId) => {
          const lineIndex = linesWithIds.findIndex((ln) => ln.id === lineId);
          const line = linesWithIds[lineIndex];
          if (!line) return null;
          return buildJavaSegment(line, lineIndex, linesWithIds, options, indent, startPoint);
        })
        .filter((s): s is string => Boolean(s));

      return `    public PathChain ${methodName}() {
        return follower.pathBuilder()
            ${segments.join(`\n${indent}`)}
            .build();
    }`;
    })
    .join("\n\n");
}

function kotlinPoseDeclarations(
  poses: Map<string, { x: number; y: number; headingRad?: number }>,
): string {
  const lines: string[] = [];

  poses.forEach((pose, name) => {
    const x = pose.x.toFixed(3);
    const y = pose.y.toFixed(3);

    if (pose.headingRad !== undefined) {
      const hdg = pose.headingRad.toFixed(4);
      lines.push(`    private val ${name} = Pose(${x}, ${y}, ${hdg})`);
    } else {
      lines.push(`    private val ${name} = Pose(${x}, ${y})`);
    }
  });

  return lines.join("\n");
}
function kotlinPathMethods(
  normalizedChains: PathChain[],
  linesWithIds: (Line & { id: string })[],
  options: ExportTransformOptions,
  startPoint?: Point,
): string {
  const indent = "            ";

  return normalizedChains
    .map((chain, chainIdx) => {
      const fnName = camelCase(
        sanitizeIdentifier(chain.name, `pathChain${chainIdx + 1}`),
      );

      const segments = chain.lineIds
        .map((lineId) => {
          const lineIndex = linesWithIds.findIndex((ln) => ln.id === lineId);
          const line = linesWithIds[lineIndex];
          if (!line) return null;
          return buildKotlinSegment(
            line,
            lineIndex,
            linesWithIds,
            options,
            indent,
            startPoint,
          );
        })
        .filter((s): s is string => Boolean(s));

      return `    fun ${fnName}(): PathChain =
        follower.pathBuilder()
            ${segments.join(`\n${indent}`)}
            .build()`;
    })
    .join("\n\n");
}
export async function generateJavaCode(
  startPoint: Point,
  lines: Line[],
  exportMode: "full" | "class" | "coordinates" = "class",
  pathChains: PathChain[] = [],
  mirrorHorizontally = false,
): Promise<string> {
  const options: ExportTransformOptions = { mirrorHorizontally };

  const linesWithIds = lines.map((line, idx) => ({
    ...line,
    id: line.id || `line-${idx + 1}`,
  })) as (Line & { id: string })[];

  const lineById = new Map(linesWithIds.map((l) => [l.id, l]));
  const chains = normalizeChains(linesWithIds, pathChains, lineById);
  const poses = collectPoses(startPoint, linesWithIds, chains, options);

  const startVarName = camelCase(sanitizeIdentifier(startPoint.name, "start"));

  if (exportMode === "coordinates") {
    return javaPathMethods(chains, linesWithIds, options, startPoint);
  }

  const pathsClass = `public class Paths {
    private final Follower follower;

${javaPoseDeclarations(poses)}

    public Paths(Follower follower) {
        this.follower = follower;
    }

${javaPathMethods(chains, linesWithIds, options, startPoint)}
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

  const chainCalls = chains
    .map((chain, idx) => {
      const name = camelCase(
        sanitizeIdentifier(chain.name, `pathChain${idx + 1}`),
      );
      return `p.${name}()`;
    })
    .join(",\n                    ");

  const file = `package org.firstinspires.ftc.teamcode;

import static com.pedropathing.ivy.commands.Commands.waitMs;

import com.acmerobotics.dashboard.FtcDashboard;
import com.acmerobotics.dashboard.telemetry.MultipleTelemetry;
import com.pedropathing.follower.Follower;
import com.pedropathing.geometry.BezierCurve;
import com.pedropathing.geometry.BezierLine;
import com.pedropathing.geometry.Pose;
import com.pedropathing.ivy.CommandBuilder;
import com.pedropathing.ivy.commands.Commands;
import com.pedropathing.ivy.groups.Groups;
import com.pedropathing.paths.PathChain;
import com.qualcomm.robotcore.eventloop.opmode.Autonomous;

@Autonomous(name = "AutoOpMode", group = "Autonomous")
public class AutoOpMode extends CommandOpMode {

    Paths p;
    Follower follower;
    MultipleTelemetry telemetryM;

    @Override
    public void init() {
        follower = new Follower(hardwareMap);
        p = new Paths(follower);

        follower.setStartingPose(p.getStart());
        follower.update();

        telemetryM = new MultipleTelemetry(
            telemetry,
            FtcDashboard.getInstance().getTelemetry()
        );

        schedule(
            Commands.infinite(() -> {
                follower.update();

                telemetryM.addData("Pose", follower.getPose());
                telemetryM.addData("T Value", follower.getCurrentTValue());
                telemetryM.update();
            }),

            Groups.sequential(
                    ${chainCalls}
            )
        );
    }

    @Override
    public void start() {
    }

    @Override
    public void stop() {
        super.stop();
    }
}

${pathsClass.replace(
  "public Paths(Follower follower) {",
  `public Pose getStart() {
        return ${startVarName};
    }

    public Paths(Follower follower) {`,
)}
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
  pathChains: PathChain[] = [],
  mirrorHorizontally = false,
): Promise<string> {
  const options: ExportTransformOptions = { mirrorHorizontally };

  const linesWithIds = lines.map((line, idx) => ({
    ...line,
    id: line.id || `line-${idx + 1}`,
  })) as (Line & { id: string })[];

  const lineById = new Map(linesWithIds.map((l) => [l.id, l]));
  const chains = normalizeChains(linesWithIds, pathChains, lineById);
  const poses = collectPoses(startPoint, linesWithIds, chains, options);

  if (exportMode === "coordinates") {
    return kotlinPathMethods(chains, linesWithIds, options, startPoint);
  }

  const pathsClass = `class Paths(private val follower: Follower) {

${kotlinPoseDeclarations(poses)}

${kotlinPathMethods(chains, linesWithIds, options, startPoint)}
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

  const chainCalls = chains
    .map((chain, idx) => {
      const name = camelCase(
        sanitizeIdentifier(chain.name, `pathChain${idx + 1}`),
      );
      return `p.${name}()`;
    })
    .join(",\n                ");

  const file = `package org.firstinspires.ftc.teamcode

import com.pedropathing.follower.Follower
import com.pedropathing.geometry.BezierCurve
import com.pedropathing.geometry.BezierLine
import com.pedropathing.geometry.Pose
import com.pedropathing.ivy.commands.Commands
import com.pedropathing.ivy.groups.Groups
import com.pedropathing.paths.PathChain

${pathsClass}

class AutoOpMode : CommandOpMode() {

    lazy var p: Paths
    lateinit var follower: Follower

    override fun init() {
        follower = Follower(hardwareMap)
        p = Paths(follower)

        follower.setStartingPose(p.start)
        follower.update()

        schedule(
            Commands.infinite {
                follower.update()
                telemetry.addData("Pose", follower.getPose())
                telemetry.update()
            },

            Groups.sequential(
                ${chainCalls}
            )
        )
    }
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
    const baseName = fileName.split(/[\\/]/).pop() || "";
    className =
      baseName.replace(".pp", "").replace(/[^a-zA-Z0-9]/g, "_") || "AutoPath";
  }

  const options: ExportTransformOptions = { mirrorHorizontally: false };

  const linesWithIds = lines.map((line, idx) => ({
    ...line,
    id: line.id || `line-${idx + 1}`,
  })) as (Line & { id: string })[];

  const lineById = new Map(linesWithIds.map((l) => [l.id, l]));

  const chains: PathChain[] = linesWithIds.map((line, idx) => ({
    id: line.id,
    name: line.name || `Path${idx + 1}`,
    color: "#22c55e",
    lineIds: [line.id],
  }));

  const normalized = normalizeChains(linesWithIds, chains, lineById);
  const poses = collectPoses(startPoint, linesWithIds, normalized, options);

  const defaultSeq: SequenceItem[] = lines.map((ln, idx) => ({
    kind: "path",
    lineId: ln.id || `line-${idx + 1}`,
  }));
  const seq = sequence && sequence.length ? sequence : defaultSeq;

  const commands: string[] = [];
  seq.forEach((item) => {
    if (item.kind === "wait") {
      commands.push(`waitMs(${(item as any).durationMs}.0)`);
      return;
    }
    const lineIdx = linesWithIds.findIndex(
      (l) => l.id === (item as any).lineId,
    );
    if (lineIdx < 0) return;

    const name = camelCase(
      sanitizeIdentifier(
        linesWithIds[lineIdx].name,
        `path${lineIdx + 1}`,
      ),
    );
    commands.push(`${name}()`);
  });

  const file = `package org.firstinspires.ftc.teamcode;

import static com.pedropathing.ivy.commands.Commands.waitMs;

import com.acmerobotics.dashboard.FtcDashboard;
import com.acmerobotics.dashboard.telemetry.MultipleTelemetry;
import com.pedropathing.follower.Follower;
import com.pedropathing.geometry.BezierCurve;
import com.pedropathing.geometry.BezierLine;
import com.pedropathing.geometry.Pose;
import com.pedropathing.ivy.CommandBuilder;
import com.pedropathing.ivy.commands.Commands;
import com.pedropathing.ivy.groups.Groups;
import com.pedropathing.paths.PathChain;
import com.qualcomm.robotcore.eventloop.opmode.Autonomous;

@Autonomous(name = "${className}", group = "Autonomous")
public class ${className} extends CommandOpMode {

    Follower follower;
    MultipleTelemetry telemetryM;

${javaPoseDeclarations(poses)}

    @Override
    public void init() {
        follower = new Follower(hardwareMap);

        follower.setStartingPose(start);
        follower.update();

        telemetryM = new MultipleTelemetry(
            telemetry,
            FtcDashboard.getInstance().getTelemetry()
        );

        schedule(
            Commands.infinite(() -> {
                follower.update();

                telemetryM.addData("Pose", follower.getPose());
                telemetryM.addData("T Value", follower.getCurrentTValue());
                telemetryM.update();
            }),

            Groups.sequential(
                    ${commands.join(",\n                    ")}
            )
        );
    }

    @Override
    public void start() {
    }

    @Override
    public void stop() {
        super.stop();
    }

${javaPathMethods(normalized, linesWithIds, options, startPoint)}
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