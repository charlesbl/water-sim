// Keep existing four-channel weather fixtures readable while uploading the
// six-channel terrain layout. New sediment tests seed all six fields directly.
export function terrainFixture(values) {
  const terrain = new Float32Array((values.length / 4) * 6);
  for (let i = 0; i < values.length; i += 4) {
    terrain.set(values.subarray(i, i + 4), (i / 4) * 6);
  }
  return terrain;
}
