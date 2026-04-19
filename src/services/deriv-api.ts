const DERIV_APP_ID = 131592;
const DERIV_WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`;
const DERIV_OAUTH_URL = `https://oauth.deriv.com/oauth2/authorize?app_id=${DERIV_APP_ID}`;

export interface DerivAccount {
  loginid: string;
  token: string;
  currency: string;
  is_virtual: boolean;
}

export interface AuthorizeResponse {
  authorize: {
    loginid: string;
    balance: number;
    currency: string;
    is_virtual: number;
    email: string;
    fullname: string;
    account_list: Array<{
      loginid: string;
      currency: string;
      is_virtual: number;
    }>;
  };
}

export interface TickData {
  tick: {
    symbol: string;
    epoch: number;
    quote: number;
    ask: number;
    bid: number;
  };
}

export interface TickHistoryResponse {
  history: {
    prices: number[];
    times: number[];
  };
}

export interface ContractResult {
  contractId: string;
  profit: number;
  status: 'won' | 'lost' | 'open';
  isExpired: boolean;
  buyPrice: number;
  sellPrice: number;
}

export type MessageHandler = (data: any) => void;

// Unified safe last digit extraction function
export function safeLastDigit(price: number): number {
  if (isNaN(price) || !isFinite(price)) return 0;
  const absolutePrice = Math.abs(price);
  const priceStr = absolutePrice.toString();
  const decimalIndex = priceStr.indexOf('.');
  
  if (decimalIndex === -1) return 0;
  
  const decimalPart = priceStr.substring(decimalIndex + 1);
  if (decimalPart.length < 1) return 0;
  
  const lastDigit = parseInt(decimalPart.charAt(decimalPart.length - 1), 10);
  return isNaN(lastDigit) ? 0 : lastDigit;
}

class DerivAPI {
  private ws: WebSocket | null = null;
  private reqId = 0;
  private handlers: Map<number, (data: any) => void> = new Map();
  private subscriptionHandlers: Map<string, MessageHandler[]> = new Map();
  private subscriptionIds: Map<string, string> = new Map();
  private globalHandlers: MessageHandler[] = [];
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  get isConnected() { return this.connected; }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    
    this.connectPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(DERIV_WS_URL);
      
      this.ws.onopen = () => {
        this.connected = true;
        resolve();
      };

      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.req_id && this.handlers.has(data.req_id)) {
          this.handlers.get(data.req_id)!(data);
          this.handlers.delete(data.req_id);
        }

        if (data.tick) {
          const symbol = data.tick.symbol;
          const handlers = this.subscriptionHandlers.get(symbol) || [];
          handlers.forEach(h => h(data));
        }

        this.globalHandlers.forEach(h => h(data));
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.connectPromise = null;
        this.subscriptionIds.clear();
      };

      this.ws.onerror = (err) => {
        this.connected = false;
        this.connectPromise = null;
        reject(err);
      };
    });

    return this.connectPromise;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
      this.connectPromise = null;
      this.handlers.clear();
      this.subscriptionHandlers.clear();
    }
  }

  private send(data: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }
      const reqId = ++this.reqId;
      data.req_id = reqId;
      this.handlers.set(reqId, resolve);
      this.ws.send(JSON.stringify(data));
      
      setTimeout(() => {
        if (this.handlers.has(reqId)) {
          this.handlers.delete(reqId);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  async authorize(token: string): Promise<AuthorizeResponse> {
    await this.connect();
    const response = await this.send({ authorize: token });
    if (response.error) throw new Error(response.error.message);
    return response;
  }

  async getBalance(): Promise<any> {
    const response = await this.send({ balance: 1, subscribe: 1 });
    if (response.error) throw new Error(response.error.message);
    return response;
  }

  async subscribeTicks(symbol: string, handler: MessageHandler) {
    if (!this.connected) await this.connect();
    
    const existing = this.subscriptionHandlers.get(symbol) || [];
    if (existing.includes(handler)) return; // Already subscribed with this handler
    
    existing.push(handler);
    this.subscriptionHandlers.set(symbol, existing);

    // Only send subscribe request if this is the first handler for this symbol
    if (existing.length === 1) {
      try {
        const response = await this.send({ ticks: symbol, subscribe: 1 });
        if (response.error) {
          console.error(`[DerivAPI] Subscription error for ${symbol}:`, response.error.message);
          this.subscriptionHandlers.delete(symbol);
          return;
        }
        if (response.subscription) {
          this.subscriptionIds.set(symbol, response.subscription.id);
        }
      } catch (err) {
        console.error(`[DerivAPI] Failed to subscribe to ${symbol}:`, err);
        this.subscriptionHandlers.delete(symbol);
      }
    }
  }

  async unsubscribeTicks(symbol: string, handler?: MessageHandler) {
    let handlers = this.subscriptionHandlers.get(symbol) || [];
    if (handler) {
      handlers = handlers.filter(h => h !== handler);
      if (handlers.length > 0) {
        this.subscriptionHandlers.set(symbol, handlers);
        return; // Still other handlers active for this symbol
      }
    }
    
    // No more handlers or explicitly unsubscribing everything for this symbol
    this.subscriptionHandlers.delete(symbol);
    const subId = this.subscriptionIds.get(symbol);
    if (subId) {
      this.subscriptionIds.delete(symbol);
      try {
        // Use forget with the specific subscription ID, NOT forget_all
        await this.send({ forget: subId });
      } catch (err) {
        console.warn(`[DerivAPI] Failed to forget ${symbol} (${subId}):`, err);
      }
    }
  }

  async getTickHistory(symbol: string, count: number = 100): Promise<TickHistoryResponse> {
    const response = await this.send({
      ticks_history: symbol,
      count,
      end: 'latest',
      style: 'ticks',
    });
    if (response.error) throw new Error(response.error.message);
    return response;
  }

  /**
   * Buy a contract and return the contract_id immediately.
   * Does NOT wait for the contract to settle.
   */
  async buyContract(params: {
    contract_type: string;
    symbol: string;
    duration: number;
    duration_unit: string;
    basis: string;
    amount: number;
    barrier?: string;
  }): Promise<{ contractId: string; buyPrice: number }> {
    // Step 1: Get proposal
    const proposalReq: any = {
      proposal: 1,
      contract_type: params.contract_type,
      symbol: params.symbol,
      duration: params.duration,
      duration_unit: params.duration_unit,
      basis: params.basis,
      amount: params.amount,
      currency: 'USD',
    };
    if (params.barrier !== undefined) {
      proposalReq.barrier = params.barrier;
    }

    const proposal = await this.send(proposalReq);
    if (proposal.error) throw new Error(proposal.error.message);

    // Step 2: Buy
    const buyResponse = await this.send({
      buy: proposal.proposal.id,
      price: params.amount,
    });
    if (buyResponse.error) throw new Error(buyResponse.error.message);

    return {
      contractId: String(buyResponse.buy.contract_id),
      buyPrice: buyResponse.buy.buy_price,
    };
  }

  /**
   * CRITICAL: Wait for a contract to fully settle (expire).
   * Subscribes to proposal_open_contract and resolves only when
   * is_expired === 1 or is_sold === 1.
   * Returns the REAL profit from Deriv API — no local guessing.
   */
  waitForContractResult(contractId: string): Promise<ContractResult> {
    return new Promise((resolve, reject) => {
      let subscriptionId: string | null = null;
      const timeout = setTimeout(() => {
        reject(new Error('Contract result timeout (60s)'));
      }, 60000);

      const checkResult = (data: any) => {
        const poc = data.proposal_open_contract;
        if (!poc) return;
        if (String(poc.contract_id) !== String(contractId)) return;

        const isSettled = poc.is_expired === 1 || poc.is_sold === 1 || poc.status === 'sold';

        if (isSettled) {
          clearTimeout(timeout);

          // Forget this subscription
          if (subscriptionId) {
            this.send({ forget: subscriptionId }).catch(() => {});
          }

          // Remove global handler
          this.globalHandlers = this.globalHandlers.filter(h => h !== checkResult);

          const profit = poc.profit || (poc.sell_price - poc.buy_price) || 0;
          const won = profit > 0;

          resolve({
            contractId: String(poc.contract_id),
            profit,
            status: won ? 'won' : 'lost',
            isExpired: poc.is_expired === 1,
            buyPrice: poc.buy_price || 0,
            sellPrice: poc.sell_price || 0,
          });
        }
      };

      // Register global handler to catch subscription messages
      this.globalHandlers.push(checkResult);

      // Subscribe to the contract
      this.send({
        proposal_open_contract: 1,
        contract_id: contractId,
        subscribe: 1,
      }).then(data => {
        if (data.error) {
          clearTimeout(timeout);
          this.globalHandlers = this.globalHandlers.filter(h => h !== checkResult);
          reject(new Error(data.error.message));
          return;
        }
        if (data.subscription) {
          subscriptionId = data.subscription.id;
        }
        // Check if already settled in the initial response
        checkResult(data);
      }).catch(err => {
        clearTimeout(timeout);
        this.globalHandlers = this.globalHandlers.filter(h => h !== checkResult);
        reject(err);
      });
    });
  }

  /** Legacy buy — kept for backward compat but prefer buyContract + waitForContractResult */
  async buy(params: {
    contract_type: string;
    symbol: string;
    duration: number;
    duration_unit: string;
    basis: string;
    amount: number;
    barrier?: string;
  }): Promise<any> {
    const { contractId, buyPrice } = await this.buyContract(params);
    const result = await this.waitForContractResult(contractId);
    return {
      buy: {
        contract_id: contractId,
        buy_price: buyPrice,
        profit: result.profit,
      },
      contractResult: result,
    };
  }

  onMessage(handler: MessageHandler) {
    this.globalHandlers.push(handler);
    return () => {
      this.globalHandlers = this.globalHandlers.filter(h => h !== handler);
    };
  }
}

export const derivApi = new DerivAPI();

export function getOAuthUrl(): string {
  return DERIV_OAUTH_URL;
}

export function parseOAuthRedirect(search: string): DerivAccount[] {
  const params = new URLSearchParams(search);
  const accounts: DerivAccount[] = [];
  
  let i = 1;
  while (params.has(`acct${i}`)) {
    accounts.push({
      loginid: params.get(`acct${i}`)!,
      token: params.get(`token${i}`)!,
      currency: params.get(`cur${i}`) || 'USD',
      is_virtual: params.get(`acct${i}`)!.startsWith('VRTC'),
    });
    i++;
  }
  
  return accounts;
}

export const MARKETS = [
  { symbol: '1HZ10V', name: 'Volatility 10 (1s)', group: 'vol' },
  { symbol: 'R_10', name: 'Volatility 10', group: 'vol' },
  { symbol: '1HZ15V', name: 'Volatility 15 (1s)', group: 'vol' },
  { symbol: '1HZ25V', name: 'Volatility 25 (1s)', group: 'vol' },
  { symbol: 'R_25', name: 'Volatility 25', group: 'vol' },
  { symbol: '1HZ30V', name: 'Volatility 30 (1s)', group: 'vol' },
  { symbol: '1HZ50V', name: 'Volatility 50 (1s)', group: 'vol' },
  { symbol: 'R_50', name: 'Volatility 50', group: 'vol' },
  { symbol: '1HZ75V', name: 'Volatility 75 (1s)', group: 'vol' },
  { symbol: 'R_75', name: 'Volatility 75', group: 'vol' },
  { symbol: '1HZ90V', name: 'Volatility 90 (1s)', group: 'vol' },
  { symbol: '1HZ100V', name: 'Volatility 100 (1s)', group: 'vol' },
  { symbol: 'R_100', name: 'Volatility 100', group: 'vol' },
  { symbol: 'JD10', name: 'Jump 10', group: 'jump' },
  { symbol: 'JD25', name: 'Jump 25', group: 'jump' },
  { symbol: 'JD50', name: 'Jump 50', group: 'jump' },
  { symbol: 'JD75', name: 'Jump 75', group: 'jump' },
  { symbol: 'JD100', name: 'Jump 100', group: 'jump' },
  { symbol: 'RDBULL', name: 'Bull Market', group: 'bull' },
  { symbol: 'RDBEAR', name: 'Bear Market', group: 'bear' },
] as const;

export type MarketSymbol = typeof MARKETS[number]['symbol'];

export const MARKET_GROUPS = [
  { value: 'vol', label: 'Volatilities' },
  { value: 'jump', label: 'Jump' },
  { value: 'bull', label: 'Bull' },
  { value: 'bear', label: 'Bear' },
] as const;

// Scanner state and types
export interface DigitDistribution {
  digit: number;
  count: number;
  percentage: number;
}

export interface ScannerState {
  symbol: MarketSymbol;
  totalTicks: number;
  distributions: DigitDistribution[];
  lastDigits: number[];
  lastPrice: number | null;
  isActive: boolean;
  lastUpdate: Date;
}

export type ScannerStatus = 'idle' | 'scanning' | 'paused' | 'error';

// Scanner class for tracking digit distributions
export class LastDigitScanner {
  private symbol: MarketSymbol;
  private maxTicks: number;
  private distributions: Map<number, number>;
  private lastDigits: number[];
  private lastPrice: number | null;
  private isActive: boolean;
  private status: ScannerStatus;
  private errorMessage: string | null;
  private unsubscribeFn: (() => void) | null = null;
  private tickHandler: MessageHandler | null = null;

  constructor(symbol: MarketSymbol, maxTicks: number = 500) {
    this.symbol = symbol;
    this.maxTicks = maxTicks;
    this.distributions = new Map();
    this.lastDigits = [];
    this.lastPrice = null;
    this.isActive = false;
    this.status = 'idle';
    this.errorMessage = null;
  }

  getState(): ScannerState {
    const distributions: DigitDistribution[] = [];
    const totalTicks = this.lastDigits.length;
    
    for (let i = 0; i <= 9; i++) {
      const count = this.distributions.get(i) || 0;
      // Always calculate percentage using (count / totalTicks) * 100
      const percentage = totalTicks > 0 ? (count / totalTicks) * 100 : 0;
      distributions.push({
        digit: i,
        count,
        percentage
      });
    }
    
    return {
      symbol: this.symbol,
      totalTicks,
      distributions,
      lastDigits: [...this.lastDigits],
      lastPrice: this.lastPrice,
      isActive: this.isActive,
      lastUpdate: new Date()
    };
  }

  async start(): Promise<void> {
    if (this.isActive) return;
    if (this.status === 'error') this.clearError();
    
    this.isActive = true;
    this.status = 'scanning';
    
    // Clear existing data when starting new scan
    this.distributions.clear();
    this.lastDigits = [];
    this.lastPrice = null;
    
    // First, load historical ticks
    try {
      const history = await derivApi.getTickHistory(this.symbol, this.maxTicks);
      if (history.history && history.history.prices) {
        for (const price of history.history.prices) {
          this.processTick(price);
        }
      }
    } catch (err) {
      console.error(`Failed to load tick history for ${this.symbol}:`, err);
      this.errorMessage = `Failed to load history: ${err instanceof Error ? err.message : String(err)}`;
      this.status = 'error';
      this.isActive = false;
      throw err;
    }
    
    // Subscribe to live ticks
    this.tickHandler = (data: any) => {
      if (data.tick && data.tick.symbol === this.symbol) {
        this.processTick(data.tick.quote);
      }
    };
    
    await derivApi.subscribeTicks(this.symbol, this.tickHandler);
  }

  pause(): void {
    if (!this.isActive) return;
    this.isActive = false;
    this.status = 'paused';
  }

  resume(): void {
    if (this.isActive) return;
    if (this.status === 'error') this.clearError();
    this.isActive = true;
    this.status = 'scanning';
  }

  async stop(): Promise<void> {
    this.isActive = false;
    this.status = 'idle';
    
    if (this.tickHandler) {
      await derivApi.unsubscribeTicks(this.symbol, this.tickHandler);
      this.tickHandler = null;
    }
    
    this.unsubscribeFn = null;
  }

  private processTick(price: number): void {
    if (!this.isActive) return;
    
    this.lastPrice = price;
    const lastDigit = safeLastDigit(price);
    
    // Add to last digits array
    this.lastDigits.push(lastDigit);
    if (this.lastDigits.length > this.maxTicks) {
      const removed = this.lastDigits.shift();
      if (removed !== undefined) {
        const currentCount = this.distributions.get(removed) || 0;
        if (currentCount <= 1) {
          this.distributions.delete(removed);
        } else {
          this.distributions.set(removed, currentCount - 1);
        }
      }
    }
    
    // Update distribution
    const currentCount = this.distributions.get(lastDigit) || 0;
    this.distributions.set(lastDigit, currentCount + 1);
  }

  getStatus(): ScannerStatus {
    return this.status;
  }

  getErrorMessage(): string | null {
    return this.errorMessage;
  }

  private clearError(): void {
    this.errorMessage = null;
    this.status = 'idle';
  }
}

// Utility function to find best digit based on distribution
export function findBestDigit(distributions: DigitDistribution[]): { digit: number; percentage: number } | null {
  if (!distributions || distributions.length === 0) return null;
  
  let bestDigit = 0;
  let bestPercentage = -1;
  
  for (const dist of distributions) {
    if (dist.percentage > bestPercentage) {
      bestPercentage = dist.percentage;
      bestDigit = dist.digit;
    }
  }
  
  return bestPercentage >= 0 ? { digit: bestDigit, percentage: bestPercentage } : null;
}

// Utility function to find worst digit based on distribution
export function findWorstDigit(distributions: DigitDistribution[]): { digit: number; percentage: number } | null {
  if (!distributions || distributions.length === 0) return null;
  
  let worstDigit = 0;
  let worstPercentage = Infinity;
  
  for (const dist of distributions) {
    if (dist.percentage < worstPercentage) {
      worstPercentage = dist.percentage;
      worstDigit = dist.digit;
    }
  }
  
  return worstPercentage !== Infinity ? { digit: worstDigit, percentage: worstPercentage } : null;
}

// React hook for scanner management (compatible with React)
export function createScannerManager() {
  const scanners = new Map<MarketSymbol, LastDigitScanner>();
  
  function getScanner(symbol: MarketSymbol, maxTicks: number = 500): LastDigitScanner {
    if (!scanners.has(symbol)) {
      scanners.set(symbol, new LastDigitScanner(symbol, maxTicks));
    }
    return scanners.get(symbol)!;
  }
  
  async function startScanner(symbol: MarketSymbol, maxTicks: number = 500): Promise<LastDigitScanner> {
    const scanner = getScanner(symbol, maxTicks);
    await scanner.start();
    return scanner;
  }
  
  async function stopScanner(symbol: MarketSymbol): Promise<void> {
    const scanner = scanners.get(symbol);
    if (scanner) {
      await scanner.stop();
    }
  }
  
  function getScannerState(symbol: MarketSymbol): ScannerState | null {
    const scanner = scanners.get(symbol);
    return scanner ? scanner.getState() : null;
  }
  
  async function stopAllScanners(): Promise<void> {
    const promises = Array.from(scanners.values()).map(scanner => scanner.stop());
    await Promise.all(promises);
    scanners.clear();
  }
  
  return {
    getScanner,
    startScanner,
    stopScanner,
    getScannerState,
    stopAllScanners
  };
}

// Example React component for displaying digit distribution
export function DigitDistributionDisplay({ state }: { state: ScannerState }) {
  const getBarColor = (percentage: number) => {
    if (percentage > 15) return 'bg-red-500';
    if (percentage > 12) return 'bg-orange-500';
    if (percentage > 10) return 'bg-yellow-500';
    if (percentage > 8) return 'bg-green-500';
    return 'bg-blue-500';
  };
  
  return (
    <div className="p-4 border rounded-lg">
      <div className="mb-4">
        <h3 className="text-lg font-semibold">{state.symbol}</h3>
        <p className="text-sm text-gray-600">
          Total Ticks: {state.totalTicks} | Last Update: {state.lastUpdate.toLocaleTimeString()}
        </p>
        {state.lastPrice !== null && (
          <p className="text-sm text-gray-600">Last Price: {state.lastPrice.toFixed(5)}</p>
        )}
        {state.isActive && (
          <span className="inline-flex items-center px-2 py-1 text-xs font-medium text-green-700 bg-green-100 rounded">
            Scanning Active
          </span>
        )}
      </div>
      
      <div className="space-y-2">
        {state.distributions.map(({ digit, count, percentage }) => (
          <div key={digit} className="flex items-center gap-2">
            <div className="w-12 text-right font-mono font-bold">
              Digit {digit}:
            </div>
            <div className="flex-1">
              <div className="relative h-6 bg-gray-200 rounded overflow-hidden">
                <div
                  className={`absolute left-0 top-0 h-full ${getBarColor(percentage)} transition-all duration-300`}
                  style={{ width: `${percentage}%` }}
                />
                <div className="absolute inset-0 flex items-center justify-end pr-2 text-xs font-medium text-gray-700">
                  {count} ({percentage.toFixed(2)}%)
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      
      <div className="mt-4 pt-4 border-t">
        <div className="grid grid-cols-2 gap-4">
          {(() => {
            const best = findBestDigit(state.distributions);
            const worst = findWorstDigit(state.distributions);
            return (
              <>
                {best && (
                  <div className="p-2 bg-green-50 rounded">
                    <p className="text-sm font-medium text-green-900">Most Frequent</p>
                    <p className="text-lg font-bold text-green-700">
                      Digit {best.digit} ({best.percentage.toFixed(2)}%)
                    </p>
                  </div>
                )}
                {worst && (
                  <div className="p-2 bg-red-50 rounded">
                    <p className="text-sm font-medium text-red-900">Least Frequent</p>
                    <p className="text-lg font-bold text-red-700">
                      Digit {worst.digit} ({worst.percentage.toFixed(2)}%)
                    </p>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
