export function meshIndexForFace(faceIndex, ranges) {
  if (!Number.isInteger(faceIndex) || faceIndex < 0) return -1;
  const range = ranges.findIndex(({ start, end }) => faceIndex >= start && faceIndex < end);
  return range;
}

export function intersectsScreenRect(bounds, rect) {
  return bounds.left <= rect.right && bounds.right >= rect.left &&
    bounds.top <= rect.bottom && bounds.bottom >= rect.top;
}

export function transformPositionsByMatrix(positions, matrix) {
  const transformed = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    transformed[i] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    transformed[i + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    transformed[i + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
  }
  return transformed;
}

export function replaceMeshGroups(meshes, replacements, ...indexSets) {
  const nextMeshes = [];
  const mapped = new Map();
  meshes.forEach((mesh, index) => {
    const start = nextMeshes.length;
    nextMeshes.push(...(replacements.get(index) || [mesh]));
    mapped.set(index, Array.from({ length: nextMeshes.length - start }, (_, i) => start + i));
  });
  return {
    meshes: nextMeshes,
    indexSets: indexSets.map((indices) => new Set([...indices].flatMap((index) => mapped.get(index) || []))),
  };
}

export function combineMeshPositions(meshes, indices) {
  const ordered = [...indices].sort((a, b) => a - b);
  if (ordered.length < 2) return null;
  const selected = ordered.map((index) => meshes[index]);
  const positions = new Float32Array(selected.reduce((sum, mesh) => sum + mesh.positions.length, 0));
  let offset = 0;
  for (const mesh of selected) {
    positions.set(mesh.positions, offset);
    offset += mesh.positions.length;
  }
  return { name: selected.map((mesh) => mesh.name).join(' + '), positions };
}
