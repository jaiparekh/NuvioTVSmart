/** Extract only a locally generated FFmpeg segment name from an HLS playlist. */
export function firstHlsSegmentName(playlist) {
  const match = String(playlist || "").match(/(?:^|\n)(index-\d{6}\.m4s)(?:\r?\n|$)/);
  return match ? match[1] : null;
}
