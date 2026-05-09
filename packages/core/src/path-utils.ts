import { basename, isAbsolute, normalize, relative, resolve } from 'node:path';

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

export function isTestFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const name = basename(normalized);
  return /(?:^|\/)(?:tests?|__tests__)\/.+\.(?:php|py|[cm]?[jt]sx?)$/i.test(normalized)
    || /\.(?:test|spec)\.(?:[cm]?[jt]sx?|py)$/i.test(name)
    || /(?:Test|Spec)\.php$/i.test(name)
    || /^test_.+\.py$/i.test(name);
}
