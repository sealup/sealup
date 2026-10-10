// Bites: a module imports a module that is not on its list (plan may not know transport).
// Placed at: src/plan/imports-transport.ts
// Expect: not-allowed
import { connect } from '../transport/index.ts';

export const used = connect;
