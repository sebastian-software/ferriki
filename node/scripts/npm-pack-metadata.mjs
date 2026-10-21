function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeNpmPackMetadata(output, expectedName) {
  if (typeof expectedName !== "string" || expectedName.length === 0)
    throw new TypeError("expected npm package name must be a non-empty string");

  let result;
  try {
    result = JSON.parse(output);
  } catch (cause) {
    throw new Error(`npm pack --json returned invalid JSON for ${expectedName}`, { cause });
  }

  let metadata;
  if (Array.isArray(result)) {
    if (result.length !== 1)
      throw new Error(
        `npm pack --json returned ${result.length} package records for ${expectedName}; expected one`,
      );
    metadata = result[0];
    if (!isRecord(metadata))
      throw new Error(`npm pack --json metadata for ${expectedName} must be an object`);
    if (metadata.name !== expectedName)
      throw new Error(
        `npm pack --json returned package ${metadata.name ?? "without a name"}; expected ${expectedName}`,
      );
  } else if (isRecord(result)) {
    const packageNames = Object.keys(result);
    if (packageNames.length !== 1 || packageNames[0] !== expectedName)
      throw new Error(
        `npm pack --json returned package keys ${packageNames.join(", ") || "(none)"}; expected only ${expectedName}`,
      );
    metadata = result[expectedName];
    if (!isRecord(metadata))
      throw new Error(`npm pack --json metadata for ${expectedName} must be an object`);
    if (metadata.name !== undefined && metadata.name !== expectedName)
      throw new Error(
        `npm pack --json returned package ${metadata.name}; expected ${expectedName}`,
      );
    metadata = { ...metadata, name: expectedName };
  } else {
    throw new Error(`npm pack --json metadata for ${expectedName} must be an array or object`);
  }

  if (!Array.isArray(metadata.files))
    throw new Error(`npm pack --json metadata for ${expectedName} must include a files array`);
  if (typeof metadata.filename !== "string" || metadata.filename.length === 0)
    throw new Error(`npm pack --json metadata for ${expectedName} must include a filename`);
  if (!Number.isFinite(metadata.unpackedSize) || metadata.unpackedSize < 0)
    throw new Error(`npm pack --json metadata for ${expectedName} must include an unpacked size`);

  return metadata;
}
