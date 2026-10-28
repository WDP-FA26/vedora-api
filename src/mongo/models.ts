// The schema classes, so services can type their models and name them for
// `@InjectModel`, plus the enums. `id` is the string view of `_id`.
export * from './enums';
export * from './schemas';

/** A stored document: the model with `id` under its stored name `_id`. */
export type Stored<T extends { id: string }> = Omit<T, 'id'> & { _id: string };
