import { OrbitControls } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { MOUSE, TOUCH } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

interface SceneControlsProps {
  maxX: number;
  maxZ: number;
  verticalSpan: number;
  initialTarget: [number, number, number];
}

export function SceneControls({ maxX, maxZ, verticalSpan, initialTarget }: SceneControlsProps) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const didInitializeTargetRef = useRef(false);
  const focusX = Math.max(1.1, maxX * 0.42);
  const focusZ = Math.max(1.1, maxZ * 0.42);
  const focusY = Math.max(0.75, verticalSpan * 0.22);
  const sceneRadius = Math.max(maxX, maxZ);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls || didInitializeTargetRef.current) {
      return;
    }

    controls.target.set(...initialTarget);
    controls.update();
    didInitializeTargetRef.current = true;
  }, [initialTarget]);

  useFrame(() => {
    const controls = controlsRef.current;

    if (!controls) {
      return;
    }

    controls.target.x = clamp(controls.target.x, -focusX, focusX);
    controls.target.y = clamp(controls.target.y, -0.35, focusY + 0.95);
    controls.target.z = clamp(controls.target.z, -focusZ, focusZ);
  });

  return (
    <OrbitControls
      ref={controlsRef}
      enablePan
      enableZoom
      enableRotate
      enableDamping
      screenSpacePanning={false}
      dampingFactor={0.08}
      panSpeed={1.15}
      rotateSpeed={0.72}
      minDistance={Math.max(7.5, sceneRadius * 1.42)}
      maxDistance={Math.max(20, sceneRadius * 3.5)}
      minPolarAngle={Math.PI / 18}
      maxPolarAngle={Math.PI / 2.08}
      maxAzimuthAngle={Math.PI / 2.35}
      minAzimuthAngle={-Math.PI / 2.35}
      mouseButtons={{
        LEFT: MOUSE.PAN,
        MIDDLE: MOUSE.DOLLY,
        RIGHT: MOUSE.ROTATE,
      }}
      touches={{
        ONE: TOUCH.PAN,
        TWO: TOUCH.DOLLY_PAN,
      }}
    />
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
