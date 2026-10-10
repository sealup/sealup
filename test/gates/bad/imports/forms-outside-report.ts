// Bites: only report writes GitHub's mask lines, the one place a secret's forms are printed (R2,
// spec #24 decision 30); transport may import secret, but not secretForms().
// Placed at: src/transport/forms.ts
// Expect: forms-only-report
import { secretForms } from '../secret/index.ts';

export const used = secretForms;
