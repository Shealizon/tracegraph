export const FILE_ACCESS_MODES = Object.freeze({
  READ_ONLY: 'read-only',
  ASK: 'ask',
  ALLOW: 'allow',
});

export function normalizeFileAccessMode(value) {
  return Object.values(FILE_ACCESS_MODES).includes(value) ? value : FILE_ACCESS_MODES.ASK;
}

export function fileAccessLabel(value) {
  const mode = normalizeFileAccessMode(value);
  if (mode === FILE_ACCESS_MODES.READ_ONLY) return '只读';
  if (mode === FILE_ACCESS_MODES.ALLOW) return '完全允许写入';
  return '每次询问写入';
}
