const data = [
    [0.60, -36.95],
    [0.70, -33.87],
    [0.80, -31.13],
    [0.90, -28.65],
    [1.00, -26.37],
    [1.20, -22.32],
    [1.40, -18.77],
    [1.60, -15.6],
    [1.80, -12.73],
    [2.00, -10.09],
    [2.40, -5.38],
    [2.80, -1.25],
    [3.20, 2.46],
    [3.60, 5.82],
    [4.00, 8.91],
    [4.50, 12.46],
    [5.00, 15.71],
    [5.50, 18.73],
    [6.00, 21.55],
    [6.50, 24.20],
    [7.00, 26.69],
    [7.50, 29.06],
    [8.00, 31.31],
    [8.50, 33.45],
    [9.00, 35.51],
    [9.50, 37.48],
    [10.00, 39.37]
];

function getSaturationTemp(pressureBar) {
    for (let i = 0; i < data.length; i++) {
        if (pressureBar === data[i][0]) {
            return data[i][1];
        } else if (pressureBar < data[i][0]) {
            if (i === 0) return;
            return data[i - 1][1] + (data[i][1] - data[i - 1][1]) * (pressureBar - data[i - 1][0]) / (data[i][0] - data[i - 1][0]);
        }
    }
}

[0.5, 0.6, 2.4, 2.41, 2.6, 2.8, 10, 20].forEach(p => console.info(`${p} bar -> ${getSaturationTemp(p)} C`));

console.info("ok");