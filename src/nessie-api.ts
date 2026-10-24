/** Nessie API client — Capital One's hackathon banking API (https://api.nessieisreal.com).
 *
 * Every festival's financial backbone lives here: customers represent festival organizations,
 * accounts hold operating and escrow funds, merchants are the vendors and production companies,
 * and transactions are the ticket revenue, vendor payments, and artist fees that flow through. */

const BASE = 'https://api.nessieisreal.com';

function key(): string {
  return process.env.NESSIE_API_KEY ?? '';
}

function endpoint(path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${BASE}${path}${sep}key=${key()}`;
}

export function hasNessieKey(): boolean {
  return key().length > 0;
}

export async function nessieGet<T = any>(path: string): Promise<T> {
  const res = await fetch(endpoint(path));
  if (!res.ok) throw new Error(`Nessie GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function nessiePost<T = any>(path: string, body: Record<string, any>): Promise<T> {
  const res = await fetch(endpoint(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Nessie POST ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function nessiePut(path: string, body: Record<string, any>): Promise<void> {
  const res = await fetch(endpoint(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Nessie PUT ${path}: ${res.status} ${await res.text()}`);
}

export async function nessieDelete(path: string): Promise<void> {
  const res = await fetch(endpoint(path), { method: 'DELETE' });
  if (!res.ok) throw new Error(`Nessie DELETE ${path}: ${res.status} ${await res.text()}`);
}

// ---- Customers (festival organizations) -----------------------------------------------------------
export const createCustomer = (firstName: string, lastName: string, address: Record<string, string>) =>
  nessiePost<{ objectCreated: { _id: string } }>('/customers', { first_name: firstName, last_name: lastName, address });

export const getCustomers = () => nessieGet<any[]>('/customers');
export const getCustomer = (id: string) => nessieGet<any>(`/customers/${id}`);

// ---- Accounts (operating, escrow) -----------------------------------------------------------------
export const createAccount = (customerId: string, type: 'Checking' | 'Savings' | 'Credit Card', nickname: string, balance: number) =>
  nessiePost<{ objectCreated: { _id: string } }>(`/customers/${customerId}/accounts`, { type, nickname, rewards: 0, balance });

export const getAccounts = (customerId: string) => nessieGet<any[]>(`/customers/${customerId}/accounts`);
export const getAccount = (id: string) => nessieGet<any>(`/accounts/${id}`);

// ---- Merchants (vendors, production companies) ----------------------------------------------------
export const createMerchant = (name: string, category: string, address: Record<string, string>, geocode: { lat: number; lng: number }) =>
  nessiePost<{ objectCreated: { _id: string } }>('/merchants', { name, category, address, geocode });

export const getMerchants = () => nessieGet<any[]>('/merchants');

// ---- Deposits (ticket revenue, sponsor payments) --------------------------------------------------
export const createDeposit = (accountId: string, amount: number, description: string, date?: string) =>
  nessiePost<{ objectCreated: { _id: string } }>(`/accounts/${accountId}/deposits`, {
    medium: 'balance', transaction_date: date ?? new Date().toISOString().split('T')[0],
    status: 'pending', amount, description,
  });

export const getDeposits = (accountId: string) => nessieGet<any[]>(`/accounts/${accountId}/deposits`);

// ---- Withdrawals (artist payments, refunds) -------------------------------------------------------
export const createWithdrawal = (accountId: string, amount: number, description: string, date?: string) =>
  nessiePost<{ objectCreated: { _id: string } }>(`/accounts/${accountId}/withdrawals`, {
    medium: 'balance', transaction_date: date ?? new Date().toISOString().split('T')[0],
    status: 'pending', amount, description,
  });

// ---- Purchases (vendor payments) ------------------------------------------------------------------
export const createPurchase = (accountId: string, merchantId: string, amount: number, description: string, date?: string) =>
  nessiePost<{ objectCreated: { _id: string } }>(`/accounts/${accountId}/purchases`, {
    merchant_id: merchantId, medium: 'balance',
    purchase_date: date ?? new Date().toISOString().split('T')[0],
    amount, description,
  });

// ---- Bills (vendor invoices, service contracts) ---------------------------------------------------
export const createBill = (accountId: string, payee: string, amount: number, date?: string) =>
  nessiePost<{ objectCreated: { _id: string } }>(`/accounts/${accountId}/bills`, {
    status: 'pending', payee, nickname: payee,
    payment_date: date ?? new Date().toISOString().split('T')[0],
    recurring_date: 0, payment_amount: amount,
  });

export const getBills = (accountId: string) => nessieGet<any[]>(`/accounts/${accountId}/bills`);

// ---- Reference data -------------------------------------------------------------------------------
export const getATMs = () => nessieGet<any[]>('/atms');
export const getBranches = () => nessieGet<any[]>('/branches');

// ---- Festival setup: full banking infrastructure --------------------------------------------------
export interface FestivalNessieSetup {
  customerId: string;
  operatingId: string;
  escrowId: string;
  vendors: { name: string; nessieId: string; category: string }[];
}

const DEFAULT_ADDRESS = { street_number: '1', street_name: 'Festival Way', city: 'San Francisco', state: 'CA', zip: '94102' };
const DEFAULT_GEO = { lat: 37.7749, lng: -122.4194 };

export async function setupFestival(festivalName: string, openingBalanceDollars = 50000): Promise<FestivalNessieSetup> {
  const cust = await createCustomer(festivalName, 'Events', DEFAULT_ADDRESS);
  const customerId = cust.objectCreated._id;

  const [operating, escrow] = await Promise.all([
    createAccount(customerId, 'Checking', `${festivalName} Operating`, openingBalanceDollars),
    createAccount(customerId, 'Savings', `${festivalName} Escrow`, 0),
  ]);

  const vendorSpecs = [
    { name: 'Festival Food Co', category: 'food' },
    { name: 'Stagecraft Productions', category: 'entertainment' },
    { name: 'Shield Event Security', category: 'security' },
    { name: 'Festival Merch Co', category: 'retail' },
    { name: 'Express Event Transport', category: 'transportation' },
  ];

  const merchants = await Promise.all(
    vendorSpecs.map(v =>
      createMerchant(v.name, v.category, DEFAULT_ADDRESS, DEFAULT_GEO)
        .then(r => ({ name: v.name, nessieId: r.objectCreated._id, category: v.category })),
    ),
  );

  return { customerId, operatingId: operating.objectCreated._id, escrowId: escrow.objectCreated._id, vendors: merchants };
}

/** Push a single transaction to the live Nessie API. Returns the Nessie object ID. */
export async function recordLiveTransaction(
  accountId: string, type: 'deposit' | 'withdrawal' | 'purchase',
  amount: number, description: string, merchantId?: string, date?: string,
): Promise<string> {
  if (type === 'deposit') return (await createDeposit(accountId, amount, description, date)).objectCreated._id;
  if (type === 'withdrawal') return (await createWithdrawal(accountId, amount, description, date)).objectCreated._id;
  if (!merchantId) throw new Error('Purchase requires a merchantId');
  return (await createPurchase(accountId, merchantId, amount, description, date)).objectCreated._id;
}

/** Sync an entire festival world's transactions to the live Nessie API. */
export async function syncWorldToNessie(world: any): Promise<{ synced: number; errors: string[] }> {
  if (!hasNessieKey()) return { synced: 0, errors: ['No NESSIE_API_KEY set'] };
  const setup = await setupFestival(world.name ?? 'Festival', (world.accounts?.find((a: any) => a.id === 'nessie-operating')?.balance_minor ?? 500_000) / 100);
  world.nessieApiIds = { ...setup };
  let synced = 0;
  const errors: string[] = [];
  for (const tx of (world.nessieTransactions ?? []).slice(0, 50)) {
    try {
      const nessieId = await recordLiveTransaction(
        setup.operatingId, tx.type, tx.amount_minor / 100, tx.description,
        tx.merchant_id ? setup.vendors[0]?.nessieId : undefined,
      );
      tx.nessie_api_id = nessieId;
      synced++;
    } catch (e: any) { errors.push(`${tx.id}: ${e.message}`); }
  }
  return { synced, errors };
}
