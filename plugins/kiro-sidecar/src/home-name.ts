/**
 * A home name selects `homes/<name>/` under the state directory, so it must
 * stay a single path segment: `.` and `..` match the character rule but would
 * name the `homes/` directory itself or escape it.
 */

const HOME_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** What a valid home name looks like, for error messages. */
export const HOME_NAME_RULE =
  '1 to 64 characters from A-Z, a-z, 0-9, ".", "_" and "-", other than "." and ".."';

export function isValidHomeName(name: string): boolean {
  return HOME_NAME_PATTERN.test(name) && name !== '.' && name !== '..';
}
