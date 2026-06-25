// Mulberry32 PRNG mapped to camera angles.
//
// MUST stay byte-for-byte identical to _seeded_angles() in nodes.py so the live
// 3D preview matches the executed result exactly. Verified equal across seeds
// (0, 1, 2, 42, 12345, 0xffffffff, ...).
export function seededAngles(seed: number): {
  azimuth: number
  elevation: number
  distance: number
} {
  let a = seed >>> 0
  const rnd = (): number => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = a ^ (a >>> 15)
    t = Math.imul(t, 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const azimuth = Math.floor(rnd() * 361) // 0..360
  const elevation = Math.floor(rnd() * 91) - 30 // -30..60
  const distance = Math.floor(rnd() * 101) / 10 // 0.0..10.0
  return { azimuth, elevation, distance }
}
