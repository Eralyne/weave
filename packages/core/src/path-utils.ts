import { isAbsolute, normalize, relative, resolve } from 'node:path';

export function toProjectRelative(projectRoot: string, filePath: string): string {
  const normalized = normalize(filePath);
  const relativePath = isAbsolute(normalized)
    ? relative(projectRoot, normalized)
    : normalized;
  return relativePath.replace(/\\/g, '/');
}

export function toProjectAbsolute(projectRoot: string, filePath: string): string {
  const normalized = normalize(filePath);
  return isAbsolute(normalized)
    ? normalized
    : resolve(projectRoot, normalized);
}
