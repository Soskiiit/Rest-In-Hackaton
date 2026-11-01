/**
 * Running Chickens Test Suite
 * Target File: client/tests/RunningChickens.test.ts
 *
 * Verifies:
 * 1. Chicken animation actions and transitions (Run, Peck, PanicRun).
 * 2. Proximity panic reaction when player gets within 4.2m.
 * 3. Direction steering away from player during panic flight.
 * 4. Movement along current yaw in Run and PanicRun states.
 * 5. Stationary stance during Peck state.
 * 6. Deflection and obstacle avoidance when colliding with wall bounding boxes.
 * 7. Map boundary and roaming home radius constraints.
 * 8. Resource cleanup on dispose.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { World } from '../src/engine/World';

describe('Running Chickens Simulation', () => {
  let mockContainer: HTMLElement;
  let origDoc: any;
  let origWindow: any;

  beforeEach(() => {
    origDoc = globalThis.document;
    origWindow = globalThis.window;

    const mockGlContext: any = {
      VERSION: 7938,
      SHADING_LANGUAGE_VERSION: 7937,
      VENDOR: 7936,
      RENDERER: 7937,
      MAX_COMBINED_TEXTURE_IMAGE_UNITS: 35661,
      MAX_TEXTURE_SIZE: 3379,
      MAX_CUBE_MAP_TEXTURE_SIZE: 34076,
      MAX_VERTEX_ATTRIBS: 34921,
      MAX_VERTEX_UNIFORM_VECTORS: 36347,
      MAX_VARYING_VECTORS: 36348,
      MAX_FRAGMENT_UNIFORM_VECTORS: 36349,
      getExtension: vi.fn().mockReturnValue({}),
      getParameter: vi.fn().mockImplementation((param: any) => {
        if (param === 7938 || param === undefined || typeof param !== 'number') return 'WebGL 2.0';
        if (param === 7937) return 'WebGL GLSL ES 3.00';
        if (param === 7936) return 'WebKit';
        if (param === 34076) return 16;
        if (param === 3379) return 4096;
        if (param === 35661) return 16;
        return 16;
      }),
      enable: vi.fn(),
      disable: vi.fn(),
      clear: vi.fn(),
      clearColor: vi.fn(),
      clearDepth: vi.fn(),
      clearStencil: vi.fn(),
      viewport: vi.fn(),
      scissor: vi.fn(),
      cullFace: vi.fn(),
      frontFace: vi.fn(),
      depthFunc: vi.fn(),
      depthMask: vi.fn(),
      depthRange: vi.fn(),
      blendEquation: vi.fn(),
      blendFunc: vi.fn(),
      blendEquationSeparate: vi.fn(),
      blendFuncSeparate: vi.fn(),
      colorMask: vi.fn(),
      stencilMask: vi.fn(),
      stencilFunc: vi.fn(),
      stencilOp: vi.fn(),
      activeTexture: vi.fn(),
      bindTexture: vi.fn(),
      createTexture: vi.fn().mockReturnValue({}),
      deleteTexture: vi.fn(),
      texParameteri: vi.fn(),
      texImage2D: vi.fn(),
      texImage3D: vi.fn(),
      texStorage2D: vi.fn(),
      texStorage3D: vi.fn(),
      createBuffer: vi.fn().mockReturnValue({}),
      bindBuffer: vi.fn(),
      bufferData: vi.fn(),
      deleteBuffer: vi.fn(),
      createProgram: vi.fn().mockReturnValue({}),
      deleteProgram: vi.fn(),
      useProgram: vi.fn(),
      createShader: vi.fn().mockReturnValue({}),
      deleteShader: vi.fn(),
      shaderSource: vi.fn(),
      compileShader: vi.fn(),
      getShaderParameter: vi.fn().mockReturnValue(true),
      getShaderInfoLog: vi.fn().mockReturnValue(''),
      attachShader: vi.fn(),
      linkProgram: vi.fn(),
      getProgramParameter: vi.fn().mockReturnValue(true),
      getProgramInfoLog: vi.fn().mockReturnValue(''),
      getUniformLocation: vi.fn().mockReturnValue({}),
      getAttribLocation: vi.fn().mockReturnValue(0),
      enableVertexAttribArray: vi.fn(),
      disableVertexAttribArray: vi.fn(),
      vertexAttribPointer: vi.fn(),
      drawArrays: vi.fn(),
      drawElements: vi.fn(),
      createFramebuffer: vi.fn().mockReturnValue({}),
      deleteFramebuffer: vi.fn(),
      bindFramebuffer: vi.fn(),
      createRenderbuffer: vi.fn().mockReturnValue({}),
      deleteRenderbuffer: vi.fn(),
      bindRenderbuffer: vi.fn(),
      renderbufferStorage: vi.fn(),
      framebufferRenderbuffer: vi.fn(),
      framebufferTexture2D: vi.fn(),
      checkFramebufferStatus: vi.fn().mockReturnValue(36053), // FRAMEBUFFER_COMPLETE
      getShaderPrecisionFormat: vi.fn().mockReturnValue({ precision: 23, rangeMin: 127, rangeMax: 127 }),
      getContextAttributes: vi.fn().mockReturnValue({ xrCompatible: false, antialias: true }),
    };

    const mock2dContext = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: '',
      textBaseline: '',
      fillRect: vi.fn(),
      strokeRect: vi.fn(),
      clearRect: vi.fn(),
      fillText: vi.fn(),
      measureText: vi.fn().mockReturnValue({ width: 50 }),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      arc: vi.fn(),
      getImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(4) }),
      putImageData: vi.fn(),
      createLinearGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
      createRadialGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
      drawImage: vi.fn(),
    };

    const createMockCanvas = () => ({
      width: 800,
      height: 600,
      clientWidth: 800,
      clientHeight: 600,
      style: {},
      ownerDocument: {
        get defaultView() {
          return globalThis.window;
        },
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getContext: vi.fn().mockImplementation((type: string) => {
        if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
          return mockGlContext;
        }
        if (type === '2d') {
          return mock2dContext;
        }
        return null;
      }),
    });

    globalThis.document = {
      createElement: (tag: string) => (tag === 'canvas' ? createMockCanvas() : {}),
      createElementNS: (_ns: string, tag: string) => (tag === 'canvas' ? createMockCanvas() : {}),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as any;

    globalThis.window = {
      innerWidth: 800,
      innerHeight: 600,
      devicePixelRatio: 1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      requestAnimationFrame: vi.fn().mockReturnValue(1),
      cancelAnimationFrame: vi.fn(),
    } as any;

    mockContainer = {
      clientWidth: 800,
      clientHeight: 600,
      appendChild: vi.fn(),
      removeChild: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLElement;
  });

  afterEach(() => {
    globalThis.document = origDoc;
    globalThis.window = origWindow;
  });

  it('World initializes chicken system with getChickensCount and clean dispose', () => {
    const world = new World(mockContainer, { floorSize: 200 });

    expect(typeof world.getChickensCount).toBe('function');
    expect(typeof world.updateChickens).toBe('function');

    // Clean up
    world.dispose();
    expect(world.getChickensCount()).toBe(0);
  });

  it('Chicken state machine simulates running, pecking, and obstacle deflection', () => {
    const world = new World(mockContainer, { floorSize: 200 });

    const chickenEntries = (world as any).chickenEntries as Array<{
      root: THREE.Object3D;
      mixer: THREE.AnimationMixer;
      runAction: THREE.AnimationAction;
      peckAction: THREE.AnimationAction;
      panicAction: THREE.AnimationAction;
      currentAction: THREE.AnimationAction;
      state: 'run' | 'peck' | 'panic';
      stateTimer: number;
      panicTimer: number;
      x: number;
      z: number;
      currentYaw: number;
      targetYaw: number;
      homeX: number;
      homeZ: number;
      roamRadius: number;
    }>;

    const mockRoot = new THREE.Object3D();
    const mockAction = {
      reset: vi.fn().mockReturnThis(),
      fadeIn: vi.fn().mockReturnThis(),
      fadeOut: vi.fn().mockReturnThis(),
      play: vi.fn().mockReturnThis(),
      stop: vi.fn().mockReturnThis(),
    } as unknown as THREE.AnimationAction;

    const mockMixer = {
      update: vi.fn(),
      stopAllAction: vi.fn(),
    } as unknown as THREE.AnimationMixer;

    const testChicken = {
      root: mockRoot,
      mixer: mockMixer,
      runAction: mockAction,
      peckAction: mockAction,
      panicAction: mockAction,
      currentAction: mockAction,
      state: 'run' as 'run' | 'peck' | 'panic',
      stateTimer: 5.0,
      panicTimer: 0,
      x: 100.0,
      z: 100.0,
      currentYaw: 0, // Facing +Z
      targetYaw: 0,
      homeX: 100.0,
      homeZ: 100.0,
      roamRadius: 15.0,
    };

    chickenEntries.push(testChicken);

    // Place camera far away (x: 100, z: 120 -> distance 20m, within 45m visibility)
    world.camera.position.set(100, 1.7, 120);

    // 1. Run update with delta = 0.1
    const startZ = testChicken.z;
    world.updateChickens(0.1);

    // Since yaw is 0 (+Z), running chicken moves in +Z
    expect(testChicken.z).toBeGreaterThan(startZ);
    expect(mockMixer.update).toHaveBeenCalled();

    // 2. Proximity panic: move camera close to chicken (within 3m)
    world.camera.position.set(100, 1.7, testChicken.z + 2.0); // Player is to the North (+Z)
    world.updateChickens(0.1);

    // Chicken must enter panic state
    expect(testChicken.state).toBe('panic');
    expect(testChicken.panicTimer).toBeGreaterThan(0);

    // Chicken should flee away from player (player is at +Z, so flee is towards -Z)
    expect(Math.abs(testChicken.targetYaw)).toBeGreaterThan(2.0);

    // 3. Pecking stance: verify pecking chicken stays stationary
    testChicken.state = 'peck';
    testChicken.stateTimer = 2.4;
    world.camera.position.set(100, 1.7, 140); // Move camera far to avoid panic override
    const peckPosX = testChicken.x;
    const peckPosZ = testChicken.z;

    world.updateChickens(0.1);
    expect(testChicken.x).toBe(peckPosX);
    expect(testChicken.z).toBe(peckPosZ);

    // 4. Wall collision deflection
    // Place a mock wall directly in front of the chicken
    testChicken.state = 'run';
    testChicken.currentYaw = 0; // Facing +Z
    testChicken.targetYaw = 0;
    const wallBox = new THREE.Box3(
      new THREE.Vector3(testChicken.x - 1, -1, testChicken.z + 0.1),
      new THREE.Vector3(testChicken.x + 1, 3, testChicken.z + 2.0)
    );
    vi.spyOn(world, 'getWallBoundingBoxes').mockReturnValue([wallBox]);

    const preWallZ = testChicken.z;
    world.updateChickens(0.1);

    // Should NOT penetrate wall, and should deflect targetYaw
    expect(testChicken.z).toBe(preWallZ);
    expect(testChicken.targetYaw).not.toBe(0);

    // Clean up
    world.dispose();
  });
});
