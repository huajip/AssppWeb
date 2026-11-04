// Strip control chars, quotes, slashes and other filesystem-unsafe chars (keeps Unicode)
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[\x00-\x1F\x7F"\\/:*?<>|]/g, '-')
    .trim()
    .slice(0, 200);
}

// {name}_{bundleID}_{version}_{region}.ipa — region omitted when unknown (legacy tasks)
// Keep in sync with frontend packageFileName (components/Download/PackageQuickActions.tsx)
export function packageFileName(task: { software: { name: string; bundleID: string; version: string }; region?: string }): string {
  const parts = [task.software.name, task.software.bundleID, task.software.version, task.region]
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .map((p) => p.replace(/_+/g, '-').replace(/\s+/g, ' ').trim());
  return `${sanitizeFilename(parts.join('_'))}.ipa`;
}

