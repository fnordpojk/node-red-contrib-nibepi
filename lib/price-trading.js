// The price trading algorithm: finds the hours to buy and to avoid within a time
// window, and turns them into price levels.
module.exports = function (ctx) {
    const { nibe } = ctx;

function findTradingOpportunities(sortedPrices, originalData, config) {
    const opportunities = [];

    // ##################################################################
    // # START: KORRIGERING FÖR FLEXIBEL UPPLÖSNING                     #
    // ##################################################################
    let slotsInWindow = config.timeWindow; // Standardvärde ifall något går fel

    // Beräkna hur många minuter varje datapunkt representerar (60 för timme, 15 för kvart)
    if (originalData.length > 1) {
        const slotDurationMinutes = (originalData[1].ts - originalData[0].ts) / 60000;
        if (slotDurationMinutes > 0) {
            // Beräkna hur många "slots" som ryms i den angivna tidshorisonten i timmar
            slotsInWindow = Math.round((config.timeWindow * 60) / slotDurationMinutes);
        }
    }
    nibe.log(`[DEBUG Algorithm] Tidshorisont är ${config.timeWindow} timmar, vilket motsvarar ${slotsInWindow} datapunkter.`, 'price', 'debug');
    // ##################################################################
    // # SLUT: KORRIGERING                                              #
    // ##################################################################

    for (const lowPoint of sortedPrices) {
        let buyIndex = -1;
        for (let j = 0; j < originalData.length; j++) {
            if (lowPoint.ts === originalData[j].ts) {
                buyIndex = j;
                break;
            }
        }

        if (buyIndex === -1) continue;

         // Använder den nya, korrekt beräknade tidshorisonten
        const endIndex = Math.min(buyIndex + slotsInWindow, originalData.length);


        for (let sellIndex = buyIndex + 1; sellIndex < endIndex; sellIndex++) {
            const spread = originalData[sellIndex].value - lowPoint.value;

            if (spread > config.minSpread) {
                opportunities.push({
                    buy: lowPoint,
                    sell: originalData[sellIndex],
                    spread: spread
                });
            }
        }
    }
    const sortedOpportunities = opportunities.sort((a, b) => b.spread - a.spread);
    if (sortedOpportunities.length > 0) {
        nibe.log(`[DEBUG] Bästa funna affär: Köp för ${sortedOpportunities[0].buy.value.toFixed(2)} öre, Sälj för ${sortedOpportunities[0].sell.value.toFixed(2)} öre, Spread: ${sortedOpportunities[0].spread.toFixed(2)} öre`, 'price', 'debug');
    }
    return sortedOpportunities;
}
/**
 * Hittar den optimala kombinationen av handelsmöjligheter (ORIGINAL-VERSION)
 * @private
 */
function findOptimalCombination(opportunities) {
    if (opportunities.length === 0) return [];

    const combinations = [];

    // För varje möjlighet, bygg en kombination av icke-överlappande handel
    for (let i = 0; i < opportunities.length; i++) {
        const combination = [opportunities[i]];

        for (let j = 0; j < opportunities.length; j++) {
            if (i === j) continue;

            // Kontrollerar om en affär överlappar med någon i den nuvarande kombinationen
            const hasConflict = combination.some(trade =>
                trade.buy.ts === opportunities[j].buy.ts ||
                trade.sell.ts === opportunities[j].sell.ts ||
                trade.buy.ts === opportunities[j].sell.ts ||
                trade.sell.ts === opportunities[j].buy.ts
            );

            if (!hasConflict) {
                combination.push(opportunities[j]);
            }
        }

        const totalProfit = combination.reduce((sum, trade) => sum + trade.spread, 0);
        combinations.push({
            trades: combination,
            totalProfit: totalProfit
        });
    }

    // Returnera kombinationen med högst total profit
    combinations.sort((a, b) => b.totalProfit - a.totalProfit);
    // KORRIGERING: Ersätter "combinations[0]?.trades" med en säkrare variant.
    return combinations.length > 0 ? combinations[0].trades : [];
}
function formatResult(optimalTrades) {
    const buyPoints = [];
    const sellPoints = [];

    for (const trade of optimalTrades) {
        buyPoints.push(trade.buy);
        sellPoints.push(trade.sell);
    }

    return {
        buy: buyPoints,
        sell: sellPoints
    };
}
// Härleder prisnivåer ur en optimering. Bröts ut när varmvattnet fick tillbaka
// sin egen tidshorisont: värme och varmvatten kör samma logik på två olika
// fönster, och den fick inte finnas i fyra exemplar.
function priceLevelsFromTrades(trades, currentHourDate, fullPriceList) {
    let level = 'NORMAL';
    let veryCheapHours, cheapHours, expensiveHours, veryExpensiveHours;

    if (trades.buy.length > 0) {
        const buyPrices = trades.buy.sort((a, b) => a.value - b.value);
        const sellPrices = trades.sell.sort((a, b) => a.value - b.value);
        const buyMedianIndex = Math.floor(buyPrices.length / 2);
        const sellMedianIndex = Math.floor(sellPrices.length / 2);

        veryCheapHours = new Set(buyPrices.slice(0, buyMedianIndex).map(p => p.date));
        cheapHours = new Set(buyPrices.slice(buyMedianIndex).map(p => p.date));
        expensiveHours = new Set(sellPrices.slice(0, sellMedianIndex).map(p => p.date));
        veryExpensiveHours = new Set(sellPrices.slice(sellMedianIndex).map(p => p.date));

        if (veryCheapHours.has(currentHourDate)) level = 'VERY_CHEAP';
        else if (cheapHours.has(currentHourDate)) level = 'CHEAP';
        else if (veryExpensiveHours.has(currentHourDate)) level = 'VERY_EXPENSIVE';
        else if (expensiveHours.has(currentHourDate)) level = 'EXPENSIVE';
    }

    const prices = fullPriceList.map(p => {
        const date = p.startsAt;
        let hourLevel = 'NORMAL';
        if (veryCheapHours && veryCheapHours.has(date)) hourLevel = 'VERY_CHEAP';
        else if (cheapHours && cheapHours.has(date)) hourLevel = 'CHEAP';
        else if (veryExpensiveHours && veryExpensiveHours.has(date)) hourLevel = 'VERY_EXPENSIVE';
        else if (expensiveHours && expensiveHours.has(date)) hourLevel = 'EXPENSIVE';
        return { value: p.total * 100, level: hourLevel, ts: new Date(p.startsAt).getTime() };
    });

    return { level, prices };
}
function optimizeElectricityTrading(priceData, options = {}) {
    if (!Array.isArray(priceData) || priceData.length === 0) {
        return { buy: [], sell: [] };
    }

    const config = {
        timeWindow: Number(options.timeWindow) || 12,
        // KORRIGERAD: Använder 20 (ören) som standard, enligt originalet.
        minSpread: Number(options.minSpread) || 20
    };

    const sortedByPrice = [...priceData].sort((a, b) => a.value - b.value);
    const totalSpread = sortedByPrice[sortedByPrice.length - 1].value - sortedByPrice[0].value;

    if (totalSpread <= config.minSpread) {
        return { buy: [], sell: [] };
    }

    const tradingOpportunities = findTradingOpportunities(
        sortedByPrice,
        priceData,
        config
    );

    if (tradingOpportunities.length === 0) {
        return { buy: [], sell: [] };
    }

    const optimalCombination = findOptimalCombination(tradingOpportunities);
    return formatResult(optimalCombination);
}

    return { optimizeElectricityTrading, priceLevelsFromTrades };
};
