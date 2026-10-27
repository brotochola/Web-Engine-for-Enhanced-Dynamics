// explosionPresets.js – explosion presets for explosions.js, made in Blastforge.
// To change one, tune it in Blastforge and export this file again ("Use in Weed.js").
//
// Preset fields (sizes in px, speeds in px/s, times in seconds):
//   radius          fireball radius, px
//   fire            fire puffs
//   lobes           lobes in the fireball silhouette
//   lobeSpread      how wide each lobe is (0.05-2)
//   lobeVar         how much lobe lengths vary (0-1)
//   fireLife        fire puff life, s
//   fireSize        fire puff radius, px
//   fireHeat        how hot the fireball burns
//   drag            how fast the fireball's expansion slows, 1/s
//   smoke           smoke puffs
//   smokeLife       smoke puff life, s
//   smokeSize       smoke puff radius, px
//   smokeDensity    how thick the smoke is
//   smokeSpread     how far the smoke spreads, times the radius
//   rise            how fast smoke and embers rise, px/s
//   turbulence      sideways jitter of the smoke, px/s
//   dust            dust puffs in the ground ring
//   ringSpeed       dust ring speed, px/s
//   sparks          sparks
//   sparkSpeed      spark speed, px/s
//   debris          debris chunks
//   embers          embers
//   flash           size of the opening flash (0 = none)
//   scorch          darkness of the scorch decal (0 = none)
//   shake           camera shake, px
//   secondary       follow-up blasts
//   secondaryDelay  time between follow-up blasts, s
//   secondaryScale  size of a follow-up blast, times this one
//   flames          ground flame puffs per second
//   flameTime       how long the ground keeps burning, s

/** Colors from dark to bright: 7 for fire, 5 for smoke, 4 for dust. */
export const PALETTES = {
  fire: {
    fire: [0x4a1621, 0x8c2421, 0xcf4519, 0xf07c1e, 0xfbb13c, 0xffe373, 0xfffbe0],
    smoke: [0x1d1820, 0x342c35, 0x4e4549, 0x71676a, 0x9a8f8c],
    dust: [0x3e2f25, 0x5a4535, 0x7a5f48, 0x987a5c],
  },
  plasma: {
    fire: [0x1a1650, 0x2b3196, 0x2c66d8, 0x30a6f2, 0x74dcff, 0xc3f6ff, 0xffffff],
    smoke: [0x15142b, 0x252546, 0x383b66, 0x555c8a, 0x7e88b3],
    dust: [0x2c3049, 0x45506e, 0x677596, 0x93a1bd],
  },
  toxic: {
    fire: [0x18321b, 0x22601f, 0x3e9324, 0x7cc72b, 0xbde93d, 0xe8ff80, 0xfbffe2],
    smoke: [0x191e16, 0x2b3426, 0x424f37, 0x61704d, 0x8a9a6f],
    dust: [0x3c3a24, 0x5d5a35, 0x83804d, 0xaaa66c],
  },
  arcane: {
    fire: [0x2b0f3d, 0x56167c, 0x8d25b9, 0xc449e0, 0xee7cf1, 0xffc3f8, 0xfff3ff],
    smoke: [0x1b1323, 0x2e2239, 0x473754, 0x695579, 0x917aa0],
    dust: [0x3a2c44, 0x5a4766, 0x7e6b8a, 0xa693ae],
  },
};

export const PRESETS = {
  grenade: {
    name: 'Grenade',
    palette: PALETTES.fire,
    radius: 20, fire: 700, lobes: 5, lobeSpread: 0.5, lobeVar: 0.45, fireLife: 0.7, fireSize: 5,
    fireHeat: 1.25, drag: 7, smoke: 380, smokeLife: 1.7, smokeSize: 6.5, smokeDensity: 1.05,
    smokeSpread: 1.05, rise: 10, turbulence: 14, dust: 200, ringSpeed: 120, sparks: 90,
    sparkSpeed: 250, debris: 18, embers: 24, flash: 1, scorch: 0.8, shake: 3, secondary: 0,
    secondaryDelay: 0.15, secondaryScale: 0.6, flames: 0, flameTime: 0,
  },
  fireball: {
    name: 'Fireball',
    palette: PALETTES.fire,
    radius: 32, fire: 1800, lobes: 7, lobeSpread: 0.45, lobeVar: 0.5, fireLife: 1, fireSize: 8,
    fireHeat: 1.3, drag: 5, smoke: 900, smokeLife: 2.6, smokeSize: 9.5, smokeDensity: 1.15, smokeSpread: 1.1,
    rise: 22, turbulence: 20, dust: 300, ringSpeed: 130, sparks: 150, sparkSpeed: 300, debris: 25,
    embers: 70, flash: 1.2, scorch: 1, shake: 6, secondary: 0, secondaryDelay: 0.15,
    secondaryScale: 0.6, flames: 0, flameTime: 0,
  },
  barrel: {
    name: 'Fuel barrel',
    palette: PALETTES.fire,
    radius: 40, fire: 2600, lobes: 9, lobeSpread: 0.35, lobeVar: 0.7, fireLife: 1.35, fireSize: 9,
    fireHeat: 1.4, drag: 4, smoke: 2000, smokeLife: 4.6, smokeSize: 13, smokeDensity: 1.5, smokeSpread: 1.35,
    rise: 22, turbulence: 26, dust: 420, ringSpeed: 160, sparks: 230, sparkSpeed: 340, debris: 60,
    embers: 150, flash: 1.3, scorch: 1.3, shake: 9, secondary: 0, secondaryDelay: 0.15,
    secondaryScale: 0.6, flames: 70, flameTime: 2.5,
  },
  napalm: {
    name: 'Napalm',
    palette: PALETTES.fire,
    radius: 46, fire: 2000, lobes: 12, lobeSpread: 0.3, lobeVar: 0.3, fireLife: 1.6, fireSize: 7,
    fireHeat: 1.15, drag: 3.5, smoke: 1700, smokeLife: 5, smokeSize: 12, smokeDensity: 1.45, smokeSpread: 1.25,
    rise: 24, turbulence: 30, dust: 250, ringSpeed: 120, sparks: 100, sparkSpeed: 200, debris: 10,
    embers: 320, flash: 0.8, scorch: 1.6, shake: 5, secondary: 0, secondaryDelay: 0.15,
    secondaryScale: 0.6, flames: 280, flameTime: 6,
  },
  chain: {
    name: 'Chain reaction',
    palette: PALETTES.fire,
    radius: 16, fire: 520, lobes: 5, lobeSpread: 0.5, lobeVar: 0.5, fireLife: 0.7, fireSize: 5,
    fireHeat: 1.25, drag: 6.5, smoke: 320, smokeLife: 2.2, smokeSize: 7, smokeDensity: 1.1, smokeSpread: 1.1,
    rise: 14, turbulence: 18, dust: 140, ringSpeed: 110, sparks: 70, sparkSpeed: 240, debris: 12,
    embers: 25, flash: 1, scorch: 0.8, shake: 4, secondary: 8, secondaryDelay: 0.13,
    secondaryScale: 0.85, flames: 0, flameTime: 0,
  },
  mega: {
    name: 'Mega blast',
    palette: PALETTES.fire,
    radius: 78, fire: 5200, lobes: 11, lobeSpread: 0.4, lobeVar: 0.6, fireLife: 1.9, fireSize: 14,
    fireHeat: 1.5, drag: 3.2, smoke: 4000, smokeLife: 6.5, smokeSize: 22, smokeDensity: 1.55, smokeSpread: 1.3,
    rise: 30, turbulence: 38, dust: 2600, ringSpeed: 430, sparks: 700, sparkSpeed: 620, debris: 160,
    embers: 420, flash: 2, scorch: 2, shake: 18, secondary: 4, secondaryDelay: 0.25,
    secondaryScale: 0.45, flames: 0, flameTime: 0,
  },
  plasma: {
    name: 'Plasma burst',
    palette: PALETTES.plasma,
    radius: 26, fire: 1600, lobes: 16, lobeSpread: 1.1, lobeVar: 0.12, fireLife: 0.75, fireSize: 6,
    fireHeat: 1.6, drag: 8, smoke: 260, smokeLife: 1.3, smokeSize: 8, smokeDensity: 0.75, smokeSpread: 1.2,
    rise: 6, turbulence: 22, dust: 0, ringSpeed: 300, sparks: 320, sparkSpeed: 430, debris: 0,
    embers: 130, flash: 1.5, scorch: 0.4, shake: 5, secondary: 0, secondaryDelay: 0.15,
    secondaryScale: 0.6, flames: 0, flameTime: 0,
  },
  toxic: {
    name: 'Toxic cloud',
    palette: PALETTES.toxic,
    radius: 24, fire: 800, lobes: 6, lobeSpread: 0.5, lobeVar: 0.5, fireLife: 0.7, fireSize: 6,
    fireHeat: 1.05, drag: 6, smoke: 2600, smokeLife: 6.5, smokeSize: 15, smokeDensity: 1.35, smokeSpread: 2,
    rise: 7, turbulence: 34, dust: 120, ringSpeed: 110, sparks: 40, sparkSpeed: 180, debris: 6,
    embers: 200, flash: 0.6, scorch: 0.6, shake: 3, secondary: 0, secondaryDelay: 0.15,
    secondaryScale: 0.6, flames: 0, flameTime: 0,
  },
  arcane: {
    name: 'Arcane nova',
    palette: PALETTES.arcane,
    radius: 30, fire: 1300, lobes: 16, lobeSpread: 0.22, lobeVar: 0.9, fireLife: 0.8, fireSize: 5,
    fireHeat: 1.4, drag: 6, smoke: 420, smokeLife: 1.8, smokeSize: 8, smokeDensity: 0.85, smokeSpread: 1.2,
    rise: 10, turbulence: 25, dust: 0, ringSpeed: 260, sparks: 420, sparkSpeed: 380, debris: 0,
    embers: 220, flash: 1.4, scorch: 0.3, shake: 5, secondary: 0, secondaryDelay: 0.15,
    secondaryScale: 0.6, flames: 0, flameTime: 0,
  },
  impact: {
    name: 'Dust impact',
    palette: PALETTES.fire,
    radius: 10, fire: 0, lobes: 6, lobeSpread: 0.45, lobeVar: 0.5, fireLife: 0.9, fireSize: 7,
    fireHeat: 1.2, drag: 5, smoke: 520, smokeLife: 2.2, smokeSize: 9, smokeDensity: 0.7, smokeSpread: 1.6,
    rise: 6, turbulence: 18, dust: 1100, ringSpeed: 190, sparks: 0, sparkSpeed: 300, debris: 55,
    embers: 0, flash: 0, scorch: 0.3, shake: 4, secondary: 0, secondaryDelay: 0.15,
    secondaryScale: 0.6, flames: 0, flameTime: 0,
  },
};
