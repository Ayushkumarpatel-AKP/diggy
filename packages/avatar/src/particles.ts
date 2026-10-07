import * as THREE from 'three';

/**
 * A tiny additive sparkle field — "magic dust" under the bot.
 *
 * One `THREE.Points` object with a fixed pool of particles, so nothing is
 * allocated per burst. Fading is done by dimming each particle's *colour*
 * toward black: with `AdditiveBlending` a black particle adds nothing, which
 * gives per-particle alpha without a custom shader.
 */
export interface SparkleBurst {
  /** How many particles to release (capped by the pool). */
  count?: number;
  /** Base colour of the dust. */
  color?: THREE.ColorRepresentation;
  /** Bright palette, picked per particle. Defaults to a high-contrast mix. */
  colors?: number[];
  /** Horizontal spread in metres. */
  spread?: number;
  /** Upward speed in metres/second. */
  rise?: number;
  /** Particle size in metres. */
  size?: number;
  /** Lifetime in milliseconds. */
  lifeMs?: number;
}

/**
 * High-contrast palette: saturated magenta / violet / gold / cyan. These stay
 * clearly visible on a white page AND on a dark one — which additive gold dust
 * never did (additive adds light, so on a white background it adds nothing).
 */
const PALETTE = [0xff1f8f, 0x7c3aed, 0xffc400, 0x00d5ff];

const DEFAULTS: Required<Omit<SparkleBurst, 'color' | 'colors'>> = {
  count: 140,
  spread: 0.46,
  rise: 0.7,
  size: 0.075,
  lifeMs: 1800,
};

/** A soft round sprite, generated once — no image asset needed. */
function makeSprite(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.75)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export class SparkleField {
  readonly points: THREE.Points;

  private readonly _max: number;
  private readonly _positions: Float32Array;
  private readonly _colors: Float32Array;
  private readonly _velocity: Float32Array;
  private readonly _life: Float32Array;
  private readonly _total: Float32Array;
  private readonly _base: Float32Array;
  private readonly _alpha: Float32Array;
  private _cursor = 0;

  constructor(maxParticles = 260) {
    this._max = Math.max(16, maxParticles);
    this._positions = new Float32Array(this._max * 3);
    this._colors = new Float32Array(this._max * 3);
    this._velocity = new Float32Array(this._max * 3);
    this._life = new Float32Array(this._max);
    this._total = new Float32Array(this._max);
    this._base = new Float32Array(this._max * 3);
    this._alpha = new Float32Array(this._max);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this._positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this._colors, 3));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(this._alpha, 1));

    // A tiny custom shader so each particle can fade its OWN alpha. Needed
    // because the dust cannot use additive blending: additive adds light, so on
    // a white page it is invisible. Normal blending needs real per-particle
    // alpha, which PointsMaterial cannot express.
    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: makeSprite() },
        size: { value: DEFAULTS.size },
      },
      vertexShader: `
        attribute vec3 color;
        attribute float alpha;
        uniform float size;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * 320.0 / max(0.001, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 tex = texture2D(map, gl_PointCoord);
          float a = tex.a * vAlpha;
          if (a < 0.02) discard;
          gl_FragColor = vec4(vColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  /** How many particles are still alive. */
  get active(): number {
    let alive = 0;
    for (let i = 0; i < this._max; i += 1) if (this._life[i]! > 0) alive += 1;
    return alive;
  }

  /** Release a puff of dust at `origin` (world space). */
  burst(origin: THREE.Vector3, options: SparkleBurst = {}): void {
    const config = { ...DEFAULTS, ...options };
    const palette = options.colors ?? (options.color !== undefined ? [Number(options.color)] : PALETTE);
    const count = Math.min(config.count, this._max);
    const life = Math.max(0.2, config.lifeMs / 1000);

    for (let n = 0; n < count; n += 1) {
      const i = this._cursor % this._max;
      this._cursor += 1;

      const angle = Math.random() * Math.PI * 2;
      const radius = config.spread * Math.sqrt(Math.random());
      const px = origin.x + Math.cos(angle) * radius;
      const pz = origin.z + Math.sin(angle) * radius * 0.6;
      const py = origin.y + Math.random() * 0.08;

      this._positions[i * 3] = px;
      this._positions[i * 3 + 1] = py;
      this._positions[i * 3 + 2] = pz;

      this._velocity[i * 3] = Math.cos(angle) * 0.12;
      this._velocity[i * 3 + 1] = config.rise * (0.4 + Math.random() * 0.8);
      this._velocity[i * 3 + 2] = Math.sin(angle) * 0.12;

      const colour = new THREE.Color(palette[Math.floor(Math.random() * palette.length)] ?? PALETTE[0]!);
      this._base[i * 3] = colour.r;
      this._base[i * 3 + 1] = colour.g;
      this._base[i * 3 + 2] = colour.b;

      this._total[i] = life * (0.7 + Math.random() * 0.6);
      this._life[i] = this._total[i]!;
      this._alpha[i] = 1;
    }

    this.points.visible = true;
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('alpha') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Advance every particle. */
  update(deltaSeconds: number): void {
    const dt = Math.min(0.05, Math.max(0, deltaSeconds));
    if (dt === 0) return;

    let alive = false;
    for (let i = 0; i < this._max; i += 1) {
      const remaining = this._life[i]!;
      if (remaining <= 0) continue;

      const left = remaining - dt;
      this._life[i] = left;
      if (left <= 0) {
        this._alpha[i] = 0;
        continue;
      }
      alive = true;

      const i3 = i * 3;
      // Drift up, slowly settling — dust, not fireworks.
      this._velocity[i3 + 1] = this._velocity[i3 + 1]! - 0.55 * dt;
      this._positions[i3] = this._positions[i3]! + this._velocity[i3]! * dt;
      this._positions[i3 + 1] = this._positions[i3 + 1]! + this._velocity[i3 + 1]! * dt;
      this._positions[i3 + 2] = this._positions[i3 + 2]! + this._velocity[i3 + 2]! * dt;

      // Eased alpha fade — the colour stays saturated all the way, so the dust
      // reads on a white page and a dark one alike.
      const fade = Math.min(1, left / Math.max(0.001, this._total[i]!));
      this._alpha[i] = fade * fade * (3 - 2 * fade);
    }

    if (!alive) {
      this.points.visible = false;
      return;
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.points.geometry.getAttribute('alpha') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    const material = this.points.material as THREE.ShaderMaterial;
    (material.uniforms.map?.value as THREE.Texture | undefined)?.dispose();
    material.dispose();
  }
}

/** Should this clip id get a puff of dust? */
export function clipWantsSparkles(id: string): boolean {
  return /^(dance|action)\.|^emote\.(celebrate|love|surprised)|^enter\.(spin|jump)|^exit\.(spin|jump)/.test(id);
}
