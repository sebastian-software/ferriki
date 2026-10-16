// Keep engine order balanced without running timed work concurrently.
export function rotate(values, start) {
  const offset = start % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

export function coldSamples(engines, rounds, measure) {
  const samples = Object.fromEntries(engines.map((id) => [id, []]));
  for (let round = 0; round < rounds; round++) {
    for (const id of rotate(engines, round)) samples[id].push(measure(id));
  }
  return samples;
}
