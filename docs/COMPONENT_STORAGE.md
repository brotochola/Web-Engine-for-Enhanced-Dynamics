# Component Storage

WeedJS currently uses dense component arrays: most entity components allocate one slot per global entity index. This keeps hot code simple and fast:

- `entityIndex === componentIndex`
- no per-access indirection
- workers can read component fields with one typed-array lookup
- `GameObject` facades stay cheap

That layout is intentional for hot components such as `Transform`, `RigidBody`, `Collider`, and `SpriteRenderer`.

## Memory Report First

Do not migrate components to sparse storage by guesswork. Use the scene memory report first:

```javascript
const report = scene.getMemoryUsageReport();
console.table(report.componentAllocations);
```

Each component allocation includes:

- `bytes` / `formatted` — actual SharedArrayBuffer allocation
- `capacity` — allocated slots
- `entityTypeCount` — entity classes that declare the component
- `entityPoolSlots` — total entity slots belonging to those classes
- `bytesPerSlot` — approximate bytes per slot
- `estimatedUnusedSlots` / `estimatedUnusedBytes` — dense slots allocated for entity types that do not use the component
- `dedicatedPool` — true for non-entity pools such as particles, decorations, and bullets

The `estimatedUnused*` fields are an estimate for entity-indexed dense components. They are not a bug by themselves; they are a signal for design work.

## Keep Dense

Keep a component dense when one or more are true:

- It is touched in hot worker loops.
- It is used by most entity types.
- It participates in spatial, physics, rendering, or query infrastructure.
- The extra memory is small compared with the cost of an indirection layer.

Likely dense long-term:

- `Transform`
- `RigidBody`
- `Collider`
- `SpriteRenderer`

## Consider Sparse Later

Consider sparse storage only when the report shows large unused bytes and the component is not central to hot loops.

Candidates to evaluate later:

- rare marker/listener components
- heavy render-only variants
- future large custom components with many fields
- components mostly used by one or two entity types in large scenes

Sparse storage must preserve the gameplay shape (`this.someComponent`) while hiding any mapping internally. It also needs tests for worker initialization, query metadata, spawn/despawn reset, and scene teardown before replacing any existing component.

## Current Policy

For now, dense storage remains the engine default. The next step is measurement, not migration.
