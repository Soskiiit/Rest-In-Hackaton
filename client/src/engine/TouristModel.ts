import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const TOURIST_MODEL_PATHS = [
  '/models/comical_tourist.glb',
  '/assets/models/comical_tourist.glb',
];

export const TOURIST_CLIPS = [
  'Idle',
  'Walk',
  'Run',
  'Wave',
  'Angry',
  'Jump',
  'FallBack',
] as const;

export type TouristClipName = typeof TOURIST_CLIPS[number];

export interface TouristAvatarInstance {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  currentClip: string;
  isActionLocked: boolean;
  playClip: (name: string, fadeDuration?: number) => void;
  playAction: (name: string, fadeDuration?: number) => void;
  update: (delta: number) => void;
  dispose: () => void;
}

let cachedTouristGltf: GLTF | null = null;
let loadPromise: Promise<GLTF | null> | null = null;

export function getTouristTemplate(): GLTF | null {
  return cachedTouristGltf;
}

export function setTouristTemplate(gltf: GLTF | null): void {
  cachedTouristGltf = gltf;
}

/**
 * Loads the comical tourist GLB model from candidate URLs with caching.
 */
export async function loadTouristTemplate(): Promise<GLTF | null> {
  if (cachedTouristGltf) {
    return cachedTouristGltf;
  }
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    // In Node.js unit test environments without fetch/network, skip or catch gracefully
    if (typeof fetch !== 'function' && typeof window === 'undefined') {
      return null;
    }

    const loader = new GLTFLoader();
    for (const path of TOURIST_MODEL_PATHS) {
      try {
        const gltf = await loader.loadAsync(path);
        cachedTouristGltf = gltf;
        return gltf;
      } catch {
        // Continue to next candidate URL
      }
    }
    console.warn('[TouristModel] Failed to load comical_tourist.glb from candidate URLs');
    return null;
  })();

  return loadPromise;
}

/**
 * Instantiates an animated comical tourist avatar from a parsed/loaded GLTF.
 */
export function createTouristAvatarInstance(gltf: GLTF): TouristAvatarInstance {
  // 1. Clone scene hierarchy (rigid articulated nodes, no skinning)
  const root = gltf.scene.clone(true);

  // Comical tourist model faces +Z by default.
  // In Three.js and our player coordinates, facing direction is -Z (rotation = 0).
  // Rotate around Y by 180 degrees so tourist model forward (+Z) matches -Z.
  root.rotation.y = Math.PI;

  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  // 2. Setup AnimationMixer and clip actions
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<string, THREE.AnimationAction>();

  for (const clip of gltf.animations) {
    const action = mixer.clipAction(clip);
    if (clip.name === 'Idle' || clip.name === 'Walk' || clip.name === 'Run') {
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
    } else {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    actions.set(clip.name, action);
  }

  let currentClip = 'Idle';
  let isActionLocked = false;

  const instance: TouristAvatarInstance = {
    root,
    mixer,
    actions,
    get currentClip() {
      return currentClip;
    },
    get isActionLocked() {
      return isActionLocked;
    },
    set isActionLocked(val: boolean) {
      isActionLocked = val;
    },
    playClip(name: string, fadeDuration = 0.2): void {
      if (currentClip === name) return;
      const nextAction = actions.get(name);
      if (!nextAction) return;

      const prevAction = actions.get(currentClip);
      nextAction.reset();

      if (prevAction && prevAction !== nextAction) {
        prevAction.crossFadeTo(nextAction, fadeDuration, true);
      }
      nextAction.play();
      currentClip = name;
    },
    playAction(name: string, fadeDuration = 0.15): void {
      const action = actions.get(name);
      if (!action) return;

      isActionLocked = true;
      this.playClip(name, fadeDuration);
    },
    update(delta: number): void {
      mixer.update(delta);
    },
    dispose(): void {
      mixer.stopAllAction();
      root.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          mesh.geometry?.dispose();
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => m.dispose());
          } else if (mesh.material) {
            mesh.material.dispose();
          }
        }
      });
    },
  };

  // Return to Idle when a one-shot action (Wave, Angry, Jump, FallBack) completes
  mixer.addEventListener('finished', (e: any) => {
    const clipName = e.action?.getClip()?.name;
    if (clipName && clipName !== 'Idle' && clipName !== 'Walk' && clipName !== 'Run') {
      isActionLocked = false;
      instance.playClip('Idle', 0.2);
    }
  });

  // Start with Idle animation
  const idleAction = actions.get('Idle');
  if (idleAction) {
    idleAction.play();
  }

  return instance;
}
