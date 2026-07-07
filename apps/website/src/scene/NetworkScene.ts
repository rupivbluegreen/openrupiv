import * as THREE from "three";
import { computeLayout, type SectionId } from "./layouts";

const NODE_COUNT = 48;
const CONNECT_DISTANCE = 2.2;
const LERP_FACTOR = 0.04;

export class NetworkScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private points: THREE.Points;
  private lines: THREE.LineSegments;
  private positions: THREE.Vector3[];
  private targets: THREE.Vector3[];
  private currentSection: SectionId = "hero";
  private rafHandle: number | null = null;
  private readonly onResize = (): void => this.resize();
  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 100);
    this.camera.position.z = 12;

    this.positions = Array.from({ length: NODE_COUNT }, (_, i) => {
      const p = computeLayout("hero", i, NODE_COUNT);
      return new THREE.Vector3(p.x, p.y, p.z);
    });
    this.targets = this.positions.map((v) => v.clone());

    const pointGeometry = new THREE.BufferGeometry().setFromPoints(this.positions);
    const pointMaterial = new THREE.PointsMaterial({ color: 0x38bdf8, size: 0.12, transparent: true, opacity: 0.9 });
    this.points = new THREE.Points(pointGeometry, pointMaterial);
    this.scene.add(this.points);

    const lineMaterial = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.25 });
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMaterial);
    this.scene.add(this.lines);

    this.resize();
    window.addEventListener("resize", this.onResize);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
  }

  private resize(): void {
    const { innerWidth, innerHeight } = window;
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /** Called by the scroll timeline whenever the active section changes. */
  setSection(section: SectionId): void {
    if (section === this.currentSection) return;
    this.currentSection = section;
    this.targets = this.positions.map((_, i) => {
      const p = computeLayout(section, i, NODE_COUNT);
      return new THREE.Vector3(p.x, p.y, p.z);
    });
  }

  private updateLines(): void {
    const linePositions: number[] = [];
    for (let i = 0; i < NODE_COUNT; i++) {
      for (let j = i + 1; j < NODE_COUNT; j++) {
        if (this.positions[i]!.distanceTo(this.positions[j]!) < CONNECT_DISTANCE) {
          linePositions.push(this.positions[i]!.x, this.positions[i]!.y, this.positions[i]!.z);
          linePositions.push(this.positions[j]!.x, this.positions[j]!.y, this.positions[j]!.z);
        }
      }
    }
    this.lines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(linePositions, 3));
  }

  private readonly tick = (): void => {
    for (let i = 0; i < NODE_COUNT; i++) {
      this.positions[i]!.lerp(this.targets[i]!, LERP_FACTOR);
    }
    this.points.geometry.setFromPoints(this.positions);
    this.updateLines();
    this.renderer.render(this.scene, this.camera);
    this.rafHandle = requestAnimationFrame(this.tick);
  };

  start(): void {
    if (this.rafHandle === null) this.tick();
  }

  stop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  /** Releases listeners and GPU resources — call if the scene is ever torn down (not needed for this single-page app's lifetime, included for correctness). */
  dispose(): void {
    this.stop();
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.points.geometry.dispose();
    this.lines.geometry.dispose();
    this.renderer.dispose();
  }
}

/** True if this browser can create a WebGL context. */
export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (canvas.getContext("webgl2") || canvas.getContext("webgl")));
  } catch {
    return false;
  }
}
