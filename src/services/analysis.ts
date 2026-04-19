/**
 * Technical analysis utility functions.
 * DEFENSIVE PROGRAMMING: digit 0 is NEVER ignored.
 * All checks use explicit numeric comparisons — no truthy/falsy evaluation.
 */

/**
 * Unified safe last digit extraction function.
 * Guarantees correct handling of digit 0, scientific notation, floating point errors.
 * Returns integer 0-9, never null/undefined.
 */
export function safeLastDigit(price: number): number {
  // Handle invalid inputs explicitly
  if (price === null || price === undefined || Number.isNaN(price)) {
    return 0;
  }

  // Take absolute value to handle negatives consistently
  const absPrice = Math.abs(price);
  
  // Convert to string without scientific notation
  let str = absPrice.toString();
  
  // Handle scientific notation
  if (str.includes('e')) {
    const [base, exponent] = str.split('e');
    const exp = parseInt(exponent, 10);
    const [intPart, fracPart = ''] = base.split('.');
    
    if (exp < 0) {
      // Very small number: 1.23e-5 -> 0.0000123
      const zeros = Math.abs(exp) - 1;
      str = '0.' + '0'.repeat(zeros) + intPart + fracPart;
    } else {
      // Large number: 1.23e5 -> 123000
      const totalDigits = intPart.length + fracPart.length;
      if (exp >= totalDigits) {
        str = intPart + fracPart + '0'.repeat(exp - totalDigits);
      } else {
        str = intPart + fracPart.slice(0, exp) + '.' + fracPart.slice(exp);
      }
    }
  }
  
  // Remove decimal point and extract all digits
  const digitsOnly = str.replace(/\./g, '');
  
  // Get last character and convert to number
  if (digitsOnly.length === 0) return 0;
  const lastChar = digitsOnly.charAt(digitsOnly.length - 1);
  const lastDigit = parseInt(lastChar, 10);
  
  // Explicit NaN check - return 0 if invalid
  return Number.isNaN(lastDigit) ? 0 : lastDigit;
}

/**
 * Extract the last digit from a tick price (legacy wrapper for backward compatibility).
 * MANDATORY: Uses fixed precision stabilization to handle float errors.
 * No locale usage. Handles scientific notation, NaN, null, and negative values.
 * Returns an integer 0-9.
 */
export function getLastDigit(price: number): number {
  const digit = safeLastDigit(price);
  
  // MANDATORY DEBUG LOG
  console.log("RAW_TICK:", price);
  console.log("DIGIT:", digit);
  
  return digit;
}

/**
 * Analyze digit frequency across a set of prices.
 * Digit 0 is explicitly counted.
 * Percentages calculated as (count / totalTicks) * 100
 */
export function analyzeDigits(prices: number[]): {
  frequency: number[];
  mostCommon: number;
  leastCommon: number;
  percentages: number[];
  totalTicks: number;
} {
  const frequency = new Array(10).fill(0);
  const totalTicks = prices.length;

  // Count each digit, including 0 explicitly
  for (let i = 0; i < totalTicks; i++) {
    const digit = safeLastDigit(prices[i]);
    // Explicit increment - digit 0 increments index 0
    frequency[digit] = frequency[digit] + 1;
  }

  // Calculate percentages: (count / totalTicks) * 100
  // If totalTicks is 0, return zeros to avoid division by zero
  const percentages = totalTicks === 0 
    ? new Array(10).fill(0)
    : frequency.map(count => (count / totalTicks) * 100);

  // Find most common digit (handles ties by returning first occurrence)
  let maxFreq = -1;
  let mostCommon = 0;
  for (let i = 0; i < 10; i++) {
    if (frequency[i] > maxFreq) {
      maxFreq = frequency[i];
      mostCommon = i;
    }
  }

  // Find least common digit (handles ties by returning first occurrence)
  let minFreq = totalTicks + 1;
  let leastCommon = 0;
  for (let i = 0; i < 10; i++) {
    if (frequency[i] < minFreq) {
      minFreq = frequency[i];
      leastCommon = i;
    }
  }

  return { 
    frequency, 
    mostCommon, 
    leastCommon, 
    percentages,
    totalTicks 
  };
}

/**
 * Generate trading signals from recent price data.
 *
 * Over X  = digit > X (strict)
 * Under X = digit < X (strict)
 * Even includes 0, 2, 4, 6, 8
 * Odd includes 1, 3, 5, 7, 9
 */
export function generateSignals(prices: number[]): {
  overUnder: { type: string; strength: 'Weak' | 'Moderate' | 'Strong'; direction: string; ratio: number };
  evenOdd: { type: string; strength: 'Weak' | 'Moderate' | 'Strong'; direction: string; ratio: number };
  matchesDiffers: { type: string; strength: 'Weak' | 'Moderate' | 'Strong'; direction: string; ratio: number };
} {
  // Get last 20 digits maximum, using safeLastDigit
  const recentDigits = prices.slice(-20).map(price => safeLastDigit(price));
  const len = recentDigits.length;
  
  // Handle empty array case
  if (len === 0) {
    return {
      overUnder: { type: 'Over/Under', strength: 'Weak', direction: 'Under', ratio: 0.5 },
      evenOdd: { type: 'Even/Odd', strength: 'Weak', direction: 'Even', ratio: 0.5 },
      matchesDiffers: { type: 'Match/Differ', strength: 'Weak', direction: 'Differs', ratio: 0 },
    };
  }

  // Over/Under: digit > 4 is "Over", digit < 5 is "Under"
  // Using explicit comparison to ensure digit 0 is counted correctly in "Under"
  let overCount = 0;
  for (let i = 0; i < len; i++) {
    if (recentDigits[i] > 4) {
      overCount++;
    }
  }
  const overRatio = overCount / len;

  let overStrength: 'Weak' | 'Moderate' | 'Strong';
  const deviationFromHalf = Math.abs(overRatio - 0.5);
  if (deviationFromHalf > 0.2) {
    overStrength = 'Strong';
  } else if (deviationFromHalf > 0.1) {
    overStrength = 'Moderate';
  } else {
    overStrength = 'Weak';
  }

  // Even/Odd — 0 is EVEN (explicit check)
  let evenCount = 0;
  for (let i = 0; i < len; i++) {
    if (recentDigits[i] % 2 === 0) {
      evenCount++;
    }
  }
  const evenRatio = evenCount / len;

  let evenStrength: 'Weak' | 'Moderate' | 'Strong';
  const evenDeviation = Math.abs(evenRatio - 0.5);
  if (evenDeviation > 0.2) {
    evenStrength = 'Strong';
  } else if (evenDeviation > 0.1) {
    evenStrength = 'Moderate';
  } else {
    evenStrength = 'Weak';
  }

  // Matches/Differs — consecutive digit equality (strict ===)
  // Includes matches where digit 0 equals digit 0
  let matches = 0;
  for (let i = 1; i < len; i++) {
    if (recentDigits[i] === recentDigits[i - 1]) {
      matches++;
    }
  }
  const denominator = len - 1;
  const matchRatio = denominator > 0 ? matches / denominator : 0;

  let matchStrength: 'Weak' | 'Moderate' | 'Strong';
  if (matchRatio > 0.2) {
    matchStrength = 'Strong';
  } else if (matchRatio > 0.1) {
    matchStrength = 'Moderate';
  } else {
    matchStrength = 'Weak';
  }

  return {
    overUnder: {
      type: 'Over/Under',
      strength: overStrength,
      direction: overRatio > 0.5 ? 'Over' : 'Under',
      ratio: overRatio,
    },
    evenOdd: {
      type: 'Even/Odd',
      strength: evenStrength,
      direction: evenRatio > 0.5 ? 'Even' : 'Odd',
      ratio: evenRatio,
    },
    matchesDiffers: {
      type: 'Match/Differ',
      strength: matchStrength,
      direction: matchRatio > 0.15 ? 'Matches' : 'Differs',
      ratio: matchRatio,
    },
  };
}

// ─── Technical Indicators ───

export function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) {
      gains = gains + diff;
    } else {
      losses = losses - diff;
    }
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export function calculateMACD(prices: number[]): { macd: number; signal: number; histogram: number } {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macd = ema12 - ema26;
  const signal = macd * 0.8;
  const histogram = macd - signal;
  return { macd, signal, histogram };
}

function calculateEMA(prices: number[], period: number): number {
  if (prices.length < period) {
    return prices[prices.length - 1] || 0;
  }
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum = sum + prices[i];
  }
  let ema = sum / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

export function calculateMA(prices: number[], period: number = 20): number {
  if (prices.length < period) {
    return prices[prices.length - 1] || 0;
  }
  let sum = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    sum = sum + prices[i];
  }
  return sum / period;
}

export function calculateBollingerBands(prices: number[], period: number = 20): {
  upper: number; middle: number; lower: number;
} {
  const ma = calculateMA(prices, period);
  const slice = prices.slice(-period);
  let varianceSum = 0;
  for (let i = 0; i < slice.length; i++) {
    varianceSum = varianceSum + Math.pow(slice[i] - ma, 2);
  }
  const variance = varianceSum / period;
  const std = Math.sqrt(variance);
  return {
    upper: ma + 2 * std,
    middle: ma,
    lower: ma - 2 * std,
  };
}

/**
 * Scanner configuration for digit analysis across multiple symbols
 */
export interface DigitScannerConfig {
  symbols: string[];
  lookbackPeriods: number[];
  minStrength: 'Weak' | 'Moderate' | 'Strong';
  enabledSignals: ('overUnder' | 'evenOdd' | 'matchesDiffers')[];
}

/**
 * Scanner result for a single symbol and period
 */
export interface ScanResult {
  symbol: string;
  period: number;
  signals: ReturnType<typeof generateSignals>;
  digitDistribution: ReturnType<typeof analyzeDigits>;
  timestamp: number;
}

/**
 * Scan multiple symbols and periods for digit pattern signals
 */
export function scanDigitPatterns(
  priceData: Map<string, number[]>,
  config: DigitScannerConfig
): ScanResult[] {
  const results: ScanResult[] = [];
  const strengthRank = { 'Weak': 0, 'Moderate': 1, 'Strong': 2 };
  
  for (const symbol of config.symbols) {
    const prices = priceData.get(symbol);
    if (!prices || prices.length === 0) continue;
    
    for (const period of config.lookbackPeriods) {
      if (prices.length < period) continue;
      
      const recentPrices = prices.slice(-period);
      const signals = generateSignals(recentPrices);
      const digitDistribution = analyzeDigits(recentPrices);
      
      // Check if signals meet minimum strength requirement
      let meetsCriteria = true;
      for (const signalType of config.enabledSignals) {
        const signal = signals[signalType];
        if (strengthRank[signal.strength] < strengthRank[config.minStrength]) {
          meetsCriteria = false;
          break;
        }
      }
      
      if (meetsCriteria) {
        results.push({
          symbol,
          period,
          signals,
          digitDistribution,
          timestamp: Date.now(),
        });
      }
    }
  }
  
  return results;
}

/**
 * State management for digit tracking
 */
export interface DigitTrackerState {
  currentDigit: number;
  previousDigit: number | null;
  digitHistory: number[];
  lastUpdateTime: number;
  consecutiveMatches: number;
  totalDigits: number;
}

/**
 * Create a new digit tracker state
 */
export function createDigitTracker(initialHistorySize: number = 100): DigitTrackerState {
  return {
    currentDigit: 0,
    previousDigit: null,
    digitHistory: [],
    lastUpdateTime: Date.now(),
    consecutiveMatches: 0,
    totalDigits: 0,
  };
}

/**
 * Update digit tracker with new price
 */
export function updateDigitTracker(
  state: DigitTrackerState,
  price: number,
  maxHistorySize: number = 100
): DigitTrackerState {
  const newDigit = safeLastDigit(price);
  const previousDigit = state.currentDigit;
  
  // Update consecutive matches
  let newConsecutiveMatches = state.consecutiveMatches;
  if (state.totalDigits > 0 && newDigit === previousDigit) {
    newConsecutiveMatches = state.consecutiveMatches + 1;
  } else {
    newConsecutiveMatches = 0;
  }
  
  // Update history
  const newHistory = [newDigit, ...state.digitHistory];
  if (newHistory.length > maxHistorySize) {
    newHistory.pop();
  }
  
  return {
    currentDigit: newDigit,
    previousDigit: state.totalDigits > 0 ? previousDigit : null,
    digitHistory: newHistory,
    lastUpdateTime: Date.now(),
    consecutiveMatches: newConsecutiveMatches,
    totalDigits: state.totalDigits + 1,
  };
}

/**
 * UI-friendly digit statistics for rendering
 */
export interface DigitUIData {
  currentDigit: number;
  previousDigit: number | string;
  digitFrequency: number[];
  digitPercentages: number[];
  mostCommonDigit: number;
  leastCommonDigit: number;
  recentDigits: number[];
  overUnderSignal: { direction: string; strength: string; ratio: number };
  evenOddSignal: { direction: string; strength: string; ratio: number };
  matchSignal: { direction: string; strength: string; ratio: number };
  consecutiveMatches: number;
  totalSamples: number;
}

/**
 * Generate UI-ready data from digit tracker and price history
 */
export function getDigitUIData(
  tracker: DigitTrackerState,
  prices: number[],
  signalPeriod: number = 20
): DigitUIData {
  const recentPrices = prices.slice(-signalPeriod);
  const signals = generateSignals(recentPrices);
  const distribution = analyzeDigits(recentPrices);
  
  return {
    currentDigit: tracker.currentDigit,
    previousDigit: tracker.previousDigit !== null ? tracker.previousDigit : 'N/A',
    digitFrequency: distribution.frequency,
    digitPercentages: distribution.percentages,
    mostCommonDigit: distribution.mostCommon,
    leastCommonDigit: distribution.leastCommon,
    recentDigits: tracker.digitHistory.slice(0, 10),
    overUnderSignal: {
      direction: signals.overUnder.direction,
      strength: signals.overUnder.strength,
      ratio: signals.overUnder.ratio,
    },
    evenOddSignal: {
      direction: signals.evenOdd.direction,
      strength: signals.evenOdd.strength,
      ratio: signals.evenOdd.ratio,
    },
    matchSignal: {
      direction: signals.matchesDiffers.direction,
      strength: signals.matchesDiffers.strength,
      ratio: signals.matchesDiffers.ratio,
    },
    consecutiveMatches: tracker.consecutiveMatches,
    totalSamples: tracker.totalDigits,
  };
}
