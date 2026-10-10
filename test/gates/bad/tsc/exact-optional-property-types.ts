// Bites: exactOptionalPropertyTypes, an optional property set to undefined explicitly.
// Placed at: src/plan/exact-optional-property-types.ts
// Expect: TS2375
interface Options {
  readonly url?: string;
}

const missing: string | undefined = undefined;

export const options: Options = { url: missing };
