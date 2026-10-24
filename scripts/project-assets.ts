import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { Storyboard } from "../schemas/storyboard";

type StageOptions = {
  root: string;
  project: string;
  storyboard: Storyboard;
};

export type StagedProject = {
  storyboard: Storyboard;
  warnings: string[];
};

const isRemote = (file: string) => /^https?:\/\//i.test(file);

const safeRelativePath = (file: string): string => {
  if (path.isAbsolute(file)) {
    throw new Error(`Asset paths must be project-relative, received: ${file}`);
  }

  const normalized = path.posix.normalize(file.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Asset path leaves the project directory: ${file}`);
  }
  return normalized.replace(/^\.\//, "");
};

export const stageProjectAssets = ({
  root,
  project,
  storyboard,
}: StageOptions): StagedProject => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(project)) {
    throw new Error(`Invalid project name: ${project}`);
  }

  const projectDir = realpathSync(path.join(root, "projects", project));
  const publicDir = path.join(root, "remotion", "public");
  const stagedRoot = path.join(publicDir, "generated", project);
  const staged = new Set<string>();
  const warnings: string[] = [];
  const result = structuredClone(storyboard) as Storyboard;

  const stage = (file: string, optional = false): string | undefined => {
    if (isRemote(file)) return file;

    const relative = safeRelativePath(file);
    const source = path.join(projectDir, ...relative.split("/"));
    if (!existsSync(source)) {
      if (optional) {
        warnings.push(`Optional asset not found; omitted: ${relative}`);
        return undefined;
      }
      throw new Error(`Required asset not found: projects/${project}/${relative}`);
    }

    const resolvedSource = realpathSync(source);
    if (
      resolvedSource !== projectDir &&
      !resolvedSource.startsWith(projectDir + path.sep)
    ) {
      throw new Error(`Asset symlink leaves the project directory: ${relative}`);
    }
    if (!statSync(resolvedSource).isFile()) {
      throw new Error(`Asset path is not a file: ${relative}`);
    }

    const destination = path.join(stagedRoot, ...relative.split("/"));
    if (!staged.has(relative)) {
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(resolvedSource, destination);
      staged.add(relative);
    }
    return path.posix.join("generated", project, relative);
  };

  result.audioFile = stage(result.audioFile) as string;

  if (result.music) {
    const musicFile = stage(result.music.file, true);
    if (musicFile) result.music.file = musicFile;
    else delete result.music;
  }

  for (const scene of result.scenes) {
    if (scene.template === "image_zoom") {
      scene.props.imageFile = stage(scene.props.imageFile) as string;
    } else if (scene.template === "quote_cutout" && scene.props.imageFile) {
      scene.props.imageFile = stage(scene.props.imageFile) as string;
    } else if (scene.template === "video_clip") {
      scene.props.videoFile = stage(scene.props.videoFile) as string;
    }
  }

  return { storyboard: result, warnings };
};
