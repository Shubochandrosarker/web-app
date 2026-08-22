/**
 * The payment boundary.
 *
 * The businesses this platform serves first are paid by cash, bank transfer
 * or a mobile wallet (bKash, Nagad), verified by a person looking at an SMS
 * or a bank statement. So the default — and currently only — provider is
 * `manual`: it records what a staff member attests, requires no credentials,
 * and works on day one.
 *
 * A card/wallet gateway integrates by adding a provider here with
 * `requiresCredentials: true` and its own settlement flow. Nothing forces
 * one: an order system that refuses to work until Stripe keys exist would be
 * useless to the tenants this is for. No gateway is stubbed or pretended —
 * `resolvePaymentProvider` fails loudly for a provider that does not exist.
 */

export interface PaymentProvider {
  readonly name: string;
  /** Methods this provider can record. Validated at the API boundary. */
  readonly methods: readonly string[];
  /** True for gateways that need keys; the manual provider needs none. */
  readonly requiresCredentials: boolean;
  /**
   * Whether a payment recorded through this provider starts life verified.
   * Manual payments are an attestation by the person recording them, so the
   * caller chooses; a gateway would flip this on webhook confirmation.
   */
  readonly staffVerifiable: boolean;
}

const manualProvider: PaymentProvider = {
  name: 'manual',
  methods: ['cash', 'bank_transfer', 'bkash', 'nagad', 'card', 'other'],
  requiresCredentials: false,
  staffVerifiable: true,
};

const PROVIDERS: ReadonlyMap<string, PaymentProvider> = new Map([
  [manualProvider.name, manualProvider],
]);

export function resolvePaymentProvider(name = 'manual'): PaymentProvider {
  const provider = PROVIDERS.get(name);
  if (!provider) {
    const known = [...PROVIDERS.keys()].join(', ');
    throw new Error(`Unknown payment provider "${name}". Configured providers: ${known}.`);
  }
  return provider;
}
