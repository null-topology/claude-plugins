import { SidecarError } from '../errors.ts';

/**
 * A rejected argument or value, reported as `E_INVALID`. The message starts
 * with the field it names and never contains a secret.
 */
export class InvalidInputError extends SidecarError {
  override readonly code: 'E_INVALID' = 'E_INVALID';
  readonly field: string;

  constructor(field: string, message: string) {
    super('E_INVALID', `${field} ${message}`);
    this.name = 'InvalidInputError';
    this.field = field;
  }
}
