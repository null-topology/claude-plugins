/**
 * The permission policy: which option answers a `session/request_permission`.
 *
 * `allow` picks the option of kind `allow_once`, else `allow_always`; `deny`
 * picks `reject_once`, else `reject_always`. A request that offers none of the
 * needed kinds is answered with a reject kind if one is offered, else with the
 * ACP `cancelled` outcome, so no request is left unanswered. Option ids are
 * always read from the request.
 */
import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';

export type PermissionDecision = 'allow' | 'deny';

export const PERMISSION_DECISIONS: readonly PermissionDecision[] = Object.freeze(['allow', 'deny']);

const WANTED_KINDS: Readonly<Record<PermissionDecision, readonly PermissionOptionKind[]>> = Object.freeze({
  allow: Object.freeze(['allow_once', 'allow_always'] as const),
  deny: Object.freeze(['reject_once', 'reject_always'] as const),
});

const REJECT_KINDS: readonly PermissionOptionKind[] = WANTED_KINDS.deny;

/** The answer to one permission request and how it was reached. */
export interface PermissionChoice {
  readonly response: RequestPermissionResponse;
  /** The chosen option; undefined when the answer is `cancelled`. */
  readonly option: PermissionOption | undefined;
  /**
   * `policy`: an option of a wanted kind. `fallback`: none was offered, so a
   * reject kind or `cancelled` was used.
   */
  readonly via: 'policy' | 'fallback';
}

/** Chooses the answer for `options` under `decision`. Pure. */
export function choosePermission(
  options: readonly PermissionOption[],
  decision: PermissionDecision,
): PermissionChoice {
  const wanted = findByKinds(options, WANTED_KINDS[decision]);
  if (wanted !== undefined) {
    return Object.freeze({ response: selected(wanted), option: wanted, via: 'policy' });
  }
  const reject = findByKinds(options, REJECT_KINDS);
  if (reject !== undefined) {
    return Object.freeze({ response: selected(reject), option: reject, via: 'fallback' });
  }
  return Object.freeze({ response: CANCELLED_RESPONSE, option: undefined, via: 'fallback' });
}

/** The ACP answer that withdraws a permission request. */
export const CANCELLED_RESPONSE: RequestPermissionResponse = Object.freeze({
  outcome: Object.freeze({ outcome: 'cancelled' as const }),
});

function findByKinds(
  options: readonly PermissionOption[],
  kinds: readonly PermissionOptionKind[],
): PermissionOption | undefined {
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option !== undefined) {
      return option;
    }
  }
  return undefined;
}

function selected(option: PermissionOption): RequestPermissionResponse {
  return { outcome: { outcome: 'selected', optionId: option.optionId } };
}
