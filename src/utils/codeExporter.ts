import prettier from "prettier";
import type { Point, Line, BasePoint, PathChain } from "../types";
import { getCurvePoint } from "./math";

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
  const candidates = ["prettier/plugins/java.js", "prettier/plugins/java"];
  for (const path of candidates) {
    try {
      const mod = await import(/* @vite-ignore */ path);
      cachedJavaPlugin = (mod as any).default ?? mod;
      return cachedJavaPlugin;
    } catch (err) {}
  }
  cachedJavaPlugin = null;
  return null;
}

async function loadKotlinPlugin() {
  if (cachedKotlinPlugin !== null) return cachedKotlinPlugin;
  const candidates = ["prettier-plugin-kotlin"];
  for (const path of candidates) {
    try {
      const mod = await import(/* @vite-ignore */ path);
      cachedKotlinPlugin = (mod as any).default ?? mod;
      return cachedKotlinPlugin;
    } catch (err) {}
  }
  cachedKotlinPlugin = null;
  return null;
}

function sanitizeIdentifier(input: string | undefined, fallback: string): string {
  const cleaned = (input || "").replace(/[^a-zA-Z0-9]/g, "");
  if (!cleaned) return fallback;
  if (/^[0-9]/.test(cleaned)) return `${fallback}${cleaned}`;
  return cleaned;
}

// Lowercase first letter for variable names (camelCase)
function camelCase(str: string): string {
  if (!str) return str;
  return str.charAt(0).toLowerCase() + str.slice(1);
}

/**
 * Build a single path segment in the Ivy/PedroPathing style used in Far.java:
 *   robot.follower.pathBuilder()
 *     .addPath(new BezierLine(...))
 *     .setConstantHeadingInterpolation(...)
 *     .build()
 */
function buildIvyPathSegmentCode(
  line: Line,
  startExpression: string,
  options: ExportTransformOptions,
): string {
  const headingFnMap: Record<string, string> = {
    constant: "setConstantHeadingInterpolation",
    linear: "setLinearHeadingInterpolation",
    tangential: "setTangentHeadingInterpolation",
  };

  const curveType =
    line.controlPoints.length === 0 ? "BezierLine" : "BezierCurve";

  const endPose = `new Pose(${transformX(line.endPoint.x, options).toFixed(3)}, ${line.endPoint.y.toFixed(3)})`;

  const controlPointsStr = line.controlPoints
    .map(
      (pt) =>
        `new Pose(${transformX(pt.x, options).toFixed(3)}, ${pt.y.toFixed(3)})`,
    )
    .join(", ");

  const allPoints =
    controlPointsStr
      ? `${startExpression}, ${controlPointsStr}, ${endPose}`
      : `${startExpression}, ${endPose}`;

  let headingArgs = "";
  if (line.endPoint.heading === "constant") {
    headingArgs = `Math.toRadians(${transformHeadingDegrees(line.endPoint.degrees ?? 0, options).toFixed(3)})`;
  } else if (line.endPoint.heading === "linear") {
    headingArgs = `Math.toRadians(${transformHeadingDegrees(line.endPoint.startDeg ?? 0, options).toFixed(3)}), Math.toRadians(${transformHeadingDegrees(line.endPoint.endDeg ?? 0, options).toFixed(3)})`;
  }

  const reverseStr = line.endPoint.reverse ? "\n            .setReversed()" : "";

  return `.addPath(new ${curveType}(${allPoints}))
            .${headingFnMap[line.endPoint.heading]}(${headingArgs})${reverseStr}`;
}

/**
 * Build a full PathChain builder call in the Ivy style:
 *
 *   public PathChain myPath() {
 *       return follower.pathBuilder()
 *           .addPath(...)
 *           .setConstantHeadingInterpolation(...)
 *           .build();
 *   }
 */
function buildIvyPathChainMethod(
  chain: PathChain,
  chainIdx: number,
  linesWithIds: (Line & { id: string })[],
  startPoint: Point,
  options: ExportTransformOptions,
): string {
  const methodName = camelCase(
    sanitizeIdentifier(chain.name, `pathChain${chainIdx + 1}`),
  );

  const segments = chain.lineIds
    .map((lineId) => {
      const lineIndex = linesWithIds.findIndex((ln) => ln.id === lineId);
      const line = linesWithIds[lineIndex];
      if (!line) return null;

      const startExpression =
        lineIndex <= 0
          ? `new Pose(${transformX(startPoint.x, options).toFixed(3)}, ${startPoint.y.toFixed(3)})`
          : `new Pose(${transformX(linesWithIds[lineIndex - 1].endPoint.x, options).toFixed(3)}, ${linesWithIds[lineIndex - 1].endPoint.y.toFixed(3)})`;

      return buildIvyPathSegmentCode(line, startExpression, options);
    })
    .filter((s): s is string => Boolean(s));

  return `public PathChain ${methodName}() {
        return follower.pathBuilder()
            ${segments.join("\n            ")}
            .build();
    }`;
}

/**
 * Generate the Ivy-style Paths inner class, mirroring FarPaths structure:
 *
 *   public class Paths {
 *       private final Follower follower;
 *       public final Pose start;
 *
 *       public Paths(Follower follower) {
 *           this.follower = follower;
 *           this.start = new Pose(...);
 *       }
 *
 *       public PathChain myPath() { ... }
 *   }
 */
function buildIvyPathsClass(
  startPoint: Point,
  normalizedChains: PathChain[],
  linesWithIds: (Line & { id: string })[],
  options: ExportTransformOptions,
): string {
  const startPose = `new Pose(${transformX(startPoint.x, options).toFixed(3)}, ${startPoint.y.toFixed(3)}, Math.toRadians(0))`;

  const chainMethods = normalizedChains
    .map((chain, idx) =>
      buildIvyPathChainMethod(chain, idx, linesWithIds, startPoint, options),
    )
    .join("\n\n    ");

  return `public class Paths {
    private final Follower follower;
    public final Pose start;

    public Paths(Follower follower) {
        this.follower = follower;
        this.start = ${startPose};
    }

    ${chainMethods}
}`;
}

/**
 * Generate the Ivy-style autonomous OpMode, matching Far.java's structure:
 *
 *   public class AutoOpMode extends CommandOpMode {
 *       Paths p;
 *       ...
 *       public void init() { ... schedule(...) }
 *       public void start() { ... }
 *       public void stop() { ... }
 *   }
 */
function buildIvyOpModeClass(
  className: string,
  normalizedChains: PathChain[],
  startPoint: Point,
  options: ExportTransformOptions,
  pathsClassName: string = "Paths",
): string {
  // Build the sequential groups for each path chain
  const chainCalls = normalizedChains
    .map((chain, idx) => {
      const methodName = camelCase(
        sanitizeIdentifier(chain.name, `pathChain${idx + 1}`),
      );
      // Mirror the pattern from Far.java:
      //   p.myPath()
      //     .then(waitMs(250.0), robot.shootFar(p.score))
      return `Groups.sequential(
                    p.${methodName}()
                )`;
    })
    .join(",\n                ");

  return `@Autonomous(name = "${className}", group = "Autonomous")
public class ${className} extends CommandOpMode {
    ${pathsClassName} p;
    Follower follower;
    MultipleTelemetry telemetryM;

    @Override
    public void init() {
        follower = new Follower(hardwareMap);
        p = new ${pathsClassName}(follower);

        follower.setStartingPose(p.start);
        follower.update();

        telemetryM = new MultipleTelemetry(telemetry, FtcDashboard.getInstance().getTelemetry());
        telemetryM.addData("Pose", follower.getPose());
        telemetryM.update();

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
        // Add start logic here
    }

    @Override
    public void stop() {
        super.stop();
    }
}`;
}

export async function generateJavaCode(
  startPoint: Point,
  lines: Line[],
  exportMode: "full" | "class" | "coordinates" = "class",
  pathChains: PathChain[] = [],
  mirrorHorizontally = false,
): Promise<string> {
  const transformOptions: ExportTransformOptions = { mirrorHorizontally };

  const linesWithIds = lines.map((line, idx) => ({
    ...line,
    id: line.id || `line-${idx + 1}`,
  })) as (Line & { id: string })[];

  const lineById = new Map(linesWithIds.map((line) => [line.id, line]));

  const inputChains: PathChain[] =
    pathChains.length > 0
      ? pathChains
      : linesWithIds.map((line, idx) => ({
          id: line.id,
          name: line.name || `Path${idx + 1}`,
          color: "#22c55e",
          lineIds: [line.id],
        }));

  const normalizedChains: PathChain[] = inputChains
    .map((chain, idx) => ({
      ...chain,
      id: chain.id || `chain-${idx + 1}`,
      name: chain.name || `PathChain${idx + 1}`,
      lineIds: (chain.lineIds || []).filter((id) => lineById.has(id)),
    }))
    .filter((chain) => chain.lineIds.length > 0);

  // ── coordinates-only mode ────────────────────────────────────────────────
  if (exportMode === "coordinates") {
    // Return just the raw pathBuilder() chains, one per PathChain
    const snippets = normalizedChains.map((chain, chainIdx) => {
      const segments = chain.lineIds
        .map((lineId) => {
          const lineIndex = linesWithIds.findIndex((ln) => ln.id === lineId);
          const line = linesWithIds[lineIndex];
          if (!line) return null;
          const startExpression =
            lineIndex <= 0
              ? `new Pose(${transformX(startPoint.x, transformOptions).toFixed(3)}, ${startPoint.y.toFixed(3)})`
              : `new Pose(${transformX(linesWithIds[lineIndex - 1].endPoint.x, transformOptions).toFixed(3)}, ${linesWithIds[lineIndex - 1].endPoint.y.toFixed(3)})`;
          return buildIvyPathSegmentCode(line, startExpression, transformOptions);
        })
        .filter((s): s is string => Boolean(s));

      const methodName = camelCase(
        sanitizeIdentifier(chain.name, `pathChain${chainIdx + 1}`),
      );

      return `// ${methodName}\nfollower.pathBuilder()\n    ${segments.join("\n    ")}\n    .build();`;
    });

    return snippets.join("\n\n");
  }

  // ── class mode ───────────────────────────────────────────────────────────
  const pathsClass = buildIvyPathsClass(
    startPoint,
    normalizedChains,
    linesWithIds,
    transformOptions,
  );

  if (exportMode === "class") {
    try {
      const javaPlugin = await loadJavaPlugin();
      return await prettier.format(pathsClass, {
        parser: "java",
        plugins: javaPlugin ? [javaPlugin] : [],
      });
    } catch {
      return pathsClass;
    }
  }

  // ── full mode ────────────────────────────────────────────────────────────
  const opModeClass = buildIvyOpModeClass(
    "AutoOpMode",
    normalizedChains,
    startPoint,
    transformOptions,
  );

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

${opModeClass}

${pathsClass}
`;

  try {
    const javaPlugin = await loadJavaPlugin();
    return await prettier.format(file, {
      parser: "java",
      plugins: javaPlugin ? [javaPlugin] : [],
    });
  } catch (error) {
    console.error("Code formatting error:", error);
    return file;
  }
}

// ── Kotlin generation (kept compatible, same structural style) ────────────────

function buildKotlinPathSegmentCode(
  line: Line,
  startExpression: string,
  options: ExportTransformOptions,
): string {
  const headingFnMap: Record<string, string> = {
    constant: "setConstantHeadingInterpolation",
    linear: "setLinearHeadingInterpolation",
    tangential: "setTangentHeadingInterpolation",
  };

  const curveType =
    line.controlPoints.length === 0 ? "BezierLine" : "BezierCurve";

  const endPose = `Pose(${transformX(line.endPoint.x, options).toFixed(3)}, ${line.endPoint.y.toFixed(3)})`;

  const controlPointsStr = line.controlPoints
    .map(
      (pt) =>
        `Pose(${transformX(pt.x, options).toFixed(3)}, ${pt.y.toFixed(3)})`,
    )
    .join(", ");

  const allPoints =
    controlPointsStr
      ? `${startExpression}, ${controlPointsStr}, ${endPose}`
      : `${startExpression}, ${endPose}`;

  let headingArgs = "";
  if (line.endPoint.heading === "constant") {
    headingArgs = `Math.toRadians(${transformHeadingDegrees(line.endPoint.degrees ?? 0, options).toFixed(3)})`;
  } else if (line.endPoint.heading === "linear") {
    headingArgs = `Math.toRadians(${transformHeadingDegrees(line.endPoint.startDeg ?? 0, options).toFixed(3)}), Math.toRadians(${transformHeadingDegrees(line.endPoint.endDeg ?? 0, options).toFixed(3)})`;
  }

  const reverseStr = line.endPoint.reverse ? "\n            .setReversed()" : "";

  return `.addPath(${curveType}(${allPoints}))
            .${headingFnMap[line.endPoint.heading]}(${headingArgs})${reverseStr}`;
}

export async function generateKotlinCode(
  startPoint: Point,
  lines: Line[],
  exportMode: "full" | "class" | "coordinates" = "class",
  pathChains: PathChain[] = [],
  mirrorHorizontally = false,
): Promise<string> {
  const transformOptions: ExportTransformOptions = { mirrorHorizontally };

  const linesWithIds = lines.map((line, idx) => ({
    ...line,
    id: line.id || `line-${idx + 1}`,
  })) as (Line & { id: string })[];

  const lineById = new Map(linesWithIds.map((line) => [line.id, line]));

  const inputChains: PathChain[] =
    pathChains.length > 0
      ? pathChains
      : linesWithIds.map((line, idx) => ({
          id: line.id,
          name: line.name || `Path${idx + 1}`,
          color: "#22c55e",
          lineIds: [line.id],
        }));

  const normalizedChains: PathChain[] = inputChains
    .map((chain, idx) => ({
      ...chain,
      id: chain.id || `chain-${idx + 1}`,
      name: chain.name || `PathChain${idx + 1}`,
      lineIds: (chain.lineIds || []).filter((id) => lineById.has(id)),
    }))
    .filter((chain) => chain.lineIds.length > 0);

  const startPose = `Pose(${transformX(startPoint.x, transformOptions).toFixed(3)}, ${startPoint.y.toFixed(3)}, Math.toRadians(0.0))`;

  // Build fun declarations for each PathChain
  const chainFunctions = normalizedChains
    .map((chain, chainIdx) => {
      const fnName = camelCase(
        sanitizeIdentifier(chain.name, `pathChain${chainIdx + 1}`),
      );

      const segments = chain.lineIds
        .map((lineId) => {
          const lineIndex = linesWithIds.findIndex((ln) => ln.id === lineId);
          const line = linesWithIds[lineIndex];
          if (!line) return null;
          const startExpression =
            lineIndex <= 0
              ? `Pose(${transformX(startPoint.x, transformOptions).toFixed(3)}, ${startPoint.y.toFixed(3)})`
              : `Pose(${transformX(linesWithIds[lineIndex - 1].endPoint.x, transformOptions).toFixed(3)}, ${linesWithIds[lineIndex - 1].endPoint.y.toFixed(3)})`;
          return buildKotlinPathSegmentCode(
            line,
            startExpression,
            transformOptions,
          );
        })
        .filter((s): s is string => Boolean(s));

      return `    fun ${fnName}(): PathChain =
        follower.pathBuilder()
            ${segments.join("\n            ")}
            .build()`;
    })
    .join("\n\n");

  // Coordinates-only
  if (exportMode === "coordinates") {
    return chainFunctions;
  }

  const pathsClass = `class Paths(private val follower: Follower) {
    val start: Pose = ${startPose}

${chainFunctions}
}`;

  if (exportMode === "class") {
    try {
      const kotlinPlugin = await loadKotlinPlugin();
      if (!kotlinPlugin) return pathsClass;
      return await prettier.format(pathsClass, {
        parser: "kotlin",
        plugins: [kotlinPlugin],
      });
    } catch {
      return pathsClass;
    }
  }

  // Full mode
  const chainCalls = normalizedChains
    .map((chain, idx) => {
      const fnName = camelCase(
        sanitizeIdentifier(chain.name, `pathChain${idx + 1}`),
      );
      return `Groups.sequential(\n            p.${fnName}()\n        )`;
    })
    .join(",\n        ");

  const file = `package org.firstinspires.ftc.teamcode

import com.pedropathing.follower.Follower
import com.pedropathing.geometry.BezierCurve
import com.pedropathing.geometry.BezierLine
import com.pedropathing.geometry.Pose
import com.pedropathing.ivy.commands.Commands
import com.pedropathing.ivy.groups.Groups
import com.pedropathing.paths.PathChain

${pathsClass}

// TODO: Replace with your CommandOpMode subclass
class AutoOpMode : CommandOpMode() {
    lateinit var p: Paths
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
    const kotlinPlugin = await loadKotlinPlugin();
    if (!kotlinPlugin) return file;
    return await prettier.format(file, {
      parser: "kotlin",
      plugins: [kotlinPlugin],
    });
  } catch (error) {
    console.error("Kotlin code formatting error:", error);
    return file;
  }
}

// ── Points array (unchanged) ─────────────────────────────────────────────────

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

// ── Sequential Command (kept for backward compat, now uses Ivy style) ────────

export async function generateSequentialCommandCode(
  startPoint: Point,
  lines: Line[],
  fileName: string | null = null,
  sequence?: SequenceItem[],
): Promise<string> {
  let className = "AutoPath";
  if (fileName) {
    const baseName = fileName.split(/[\\/]/).pop() || "";
    className = baseName.replace(".pp", "").replace(/[^a-zA-Z0-9]/g, "_") || "AutoPath";
  }

  const linesWithIds = lines.map((line, idx) => ({
    ...line,
    id: line.id || `line-${idx + 1}`,
  })) as (Line & { id: string })[];

  // Build one PathChain per line for the sequential command format
  const normalizedChains: PathChain[] = linesWithIds.map((line, idx) => ({
    id: line.id,
    name: line.name || `Path${idx + 1}`,
    color: "#22c55e",
    lineIds: [line.id],
  }));

  const transformOptions: ExportTransformOptions = { mirrorHorizontally: false };

  // Method declarations for each path
  const pathMethods = normalizedChains
    .map((chain, idx) =>
      buildIvyPathChainMethod(chain, idx, linesWithIds, startPoint, transformOptions),
    )
    .join("\n\n    ");

  // Sequential schedule calls
  const chainCalls = normalizedChains
    .map((chain, idx) => {
      const methodName = camelCase(
        sanitizeIdentifier(chain.name, `pathChain${idx + 1}`),
      );
      return `${methodName}()`;
    })
    .join(",\n                ");

  const startPose = `new Pose(${transformX(startPoint.x, transformOptions).toFixed(3)}, ${startPoint.y.toFixed(3)}, Math.toRadians(0))`;

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

    public final Pose start = ${startPose};

    @Override
    public void init() {
        follower = new Follower(hardwareMap);
        follower.setStartingPose(start);
        follower.update();

        telemetryM = new MultipleTelemetry(telemetry, FtcDashboard.getInstance().getTelemetry());
        telemetryM.addData("Pose", follower.getPose());
        telemetryM.update();

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
        // Add start logic here
    }

    @Override
    public void stop() {
        super.stop();
    }

    ${pathMethods}
}
`;

  try {
    const javaPlugin = await loadJavaPlugin();
    return await prettier.format(file, {
      parser: "java",
      plugins: javaPlugin ? [javaPlugin] : [],
    });
  } catch (error) {
    console.error("Code formatting error:", error);
    return file;
  }
}