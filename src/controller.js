const createRegister = require("./register.js");
const asyncWait = require("./async-wait.js");

module.exports = async config => {

    let saturationData = config.saturationData[config.refrigerant];

    let peripherals = config.peripherals;

    let registers;
    registers = [
        createRegister("sequenceInProgress", "Sequence In Progress"),
        createRegister("manualControl", "Manual Control", false),
        createRegister("refrigerant", "Refrigerant", config.refrigerant),
        createRegister("evaporationTemp", "Evaporation Temperature", undefined, "°C"),
        createRegister("superheatActual", "Superheat Actual", undefined, "°C"),
        createRegister("superheatTarget", "Superheat Target", config.superheat, "°C"),
        createRegister("startedAt", "Started At"),
        createRegister("stoppedAt", "Stopped At"),
        ...peripherals.registers
    ];

    registers = registers.reduce((map, reg) => {
        map[reg.key] = reg;
        return map;
    }, {});

    let systemErrors = {};
    let systemErrorsListeners = [];

    function systemErrorsUpdated() {
        systemErrorsListeners.forEach(listener => {
            try {
                listener(systemErrors);
            } catch (e) {
                console.error("Error in system error listener", e);
            }
        });
    }

    function clearSystemError(key) {
        delete systemErrors[key];
        systemErrorsUpdated();
    }


    function setSystemError(key, message) {
        if (systemErrors[key] !== message) {
            if (message === undefined) {
                delete systemErrors[key];
            } else {
                systemErrors[key] = message;
            }
            systemErrorsUpdated();
        }
    }

    Object.values(registers).forEach(register => {
        register.watch(async register => {
            setSystemError(`register-${register.key}`, register.error ? `Register ${register.key} error: ${register.error.message || register.error}` : undefined);
        });
    });


    function checkRegisters() {

        function checkRegister(reg, min, max) {
            try {
                if (isNaN(reg.value)) throw "has no value";
                if (reg.error) throw "is in error state: " + reg.error;
                if (reg.value < min) throw `value ${reg.value} under it's minimum ${min}`;
                if (reg.value > max) throw `value ${reg.value} over it's maximum ${max}`;
            } catch (e) {
                let message = `Register ${reg.name} ${e.message || e}`;
                setSystemError(`registerCheck-${reg.name}`, message);
                throw message;
            }
        }

        checkRegister(registers.coldFrigoPressure, 0, 25);
        checkRegister(registers.hotFrigoPressure, 0, 25);
        checkRegister(registers.psLow, true, true);
        checkRegister(registers.psHigh, true, true);
        checkRegister(registers.hotFrigoInTemp, 0, 120);
    }

    async function checkRegistersAndStop() {
        if (registers.compressorRelay.value === true) {
            try {
                checkRegisters();
            } catch (e) {
                await stop();
            }
        }
    }

    registers.coldFrigoPressure.watch(checkRegistersAndStop);
    registers.hotFrigoPressure.watch(checkRegistersAndStop);
    registers.psLow.watch(checkRegistersAndStop);
    registers.psHigh.watch(checkRegistersAndStop);
    registers.hotFrigoInTemp.watch(checkRegistersAndStop);

    function getSaturationTempC(pressureBar) {
        for (let i = 0; i < saturationData.length; i++) {
            if (pressureBar === saturationData[i][0]) {
                return saturationData[i][1];
            } else if (pressureBar < saturationData[i][0]) {
                if (i === 0) return;
                return saturationData[i - 1][1] + (saturationData[i][1] - saturationData[i - 1][1]) * (pressureBar - saturationData[i - 1][0]) / (saturationData[i][0] - saturationData[i - 1][0]);
            }
        }
    }

    async function updateActualSuperheat() {
        let saturationTemp = getSaturationTempC(registers.coldFrigoPressure.value + 1);
        await registers.evaporationTemp.set(saturationTemp);
        let superheatActual = registers.coldFrigoOutTemp.value - saturationTemp;
        await registers.superheatActual.set(isNaN(superheatActual)? undefined: superheatActual);
    }

    registers.coldFrigoPressure.watch(updateActualSuperheat);
    registers.coldFrigoOutTemp.watch(updateActualSuperheat);

    async function sweep(cb, from, to, timeMs, periodMs = 100) {
        let steps = Math.ceil(timeMs / periodMs);
        for (let step = 0; step <= steps; step++) {
            await cb(from + (to - from) * step / steps);
            await asyncWait(periodMs);
        }
    }

    let sequenceInProgress;

    function notifySequenceChange() {
        // don't wait for register update - it's for UI only
        registers.sequenceInProgress.set(sequenceInProgress).catch(console.error);
    }

    async function runSequence(sequenceName, cb) {

        clearSystemError(sequenceName + "Sequence");

        console.info(`Starting sequence '${sequenceName}'...`);
        try {

            if (sequenceInProgress) {
                throw `Can not start sequence '${sequenceName}', because '${sequenceInProgress}' is in progress`;
            }

            sequenceInProgress = sequenceName;
            notifySequenceChange();

            await cb();
            console.info(`Sequence '${sequenceName}' finished.`);

            sequenceInProgress = undefined;
            notifySequenceChange();

        } catch (e) {

            console.error(`Sequence '${sequenceName}' failed: ${e.message || e}`);
            setSystemError(sequenceName + "Sequence", `${e.message || e} in sequence ${sequenceName}`);

            sequenceInProgress = undefined;
            notifySequenceChange();

            throw e;
        }
    }

    async function start() {

        try {

            await runSequence("start", async () => {

                await registers.startedAt.set(new Date());

                if (registers.compressorRelay.value === true) {
                    throw "Compressor already running";
                }

                checkRegisters();

                await config.peripherals.setColdWaterPump(true);
                await config.peripherals.setHotWaterPump(true);

                await config.peripherals.eevRun(500, true);
                await asyncWait(10000);
                await config.peripherals.eevRun(-230, false);
                await asyncWait(2000);

                await sweep(async r => {
                    await peripherals.setCompressorRamp(r);
                }, 50, 100, 800);
                await peripherals.setCompressorRelay(true);
                await asyncWait(1000);
                await peripherals.setCompressorRamp(0);

            });

        } catch (e) {
            await stop();
            throw e;
        }
    }

    async function stop() {
        await runSequence("stop", async () => {

            await registers.stoppedAt.set(new Date());

            try {
                if (registers.compressorRelay.value === true) {
                    await peripherals.setCompressorRamp(100);
                    await asyncWait(1000);
                    await peripherals.setCompressorRelay(false);
                    await asyncWait(1000);
                    await peripherals.setCompressorRamp(0);
                }
            } finally {

                await peripherals.setCompressorRelay(false);

                try {
                    await peripherals.setCompressorRamp(0);
                } catch (e) {
                    // FALL THROUGH
                    // Ramp DAC is powered from COMP_5V, which may be down in case of pressure switch stop
                }

                await peripherals.eevRun(500, true);
                await peripherals.setColdWaterPump(false);
                await peripherals.setHotWaterPump(false);
            }

        });
    }

    let lastSuperheat;

    setInterval(() => {
        let actual = registers.superheatActual.value;
        if (!sequenceInProgress && registers.manualControl.value === false && registers.compressorRelay.value === true) {
            let stepsPerC = config.eevStepsPerC || 1;
            let target = registers.superheatTarget.value;
            let steps = Math.round(((target - actual) - (actual - (lastSuperheat === undefined ? actual : lastSuperheat)) * 2 / 3) * stepsPerC);
            let maxSteps = config.eevMaxStepsPerCheck || 2;
            if (steps > maxSteps) {
                steps = maxSteps;
            }
            if (steps < -maxSteps) {
                steps = -maxSteps;
            }
            console.info(`EEV check - last SH: ${lastSuperheat}°C, actual SH: ${actual}°C, target SH: ${target}°C, steps: ${steps}`);
            if (steps) {
                peripherals.eevRun(steps, false);
            }
        }
        lastSuperheat = actual;
    }, 1000 * (config.eevIntervalSec || 5));

    return {

        registers,

        systemErrors,

        start,

        stop,

        watchSystemErrors(listener) {
            systemErrorsListeners.push(listener);
        },

        async setColdWaterPump(state) {
            await peripherals.setColdWaterPump(state);
        },

        async setHotWaterPump(state) {
            await peripherals.setHotWaterPump(state);
        },

        async eevRun(fullSteps, fast) {
            await peripherals.eevRun(fullSteps, fast);
        },

        async clearSystemError(key) {
            clearSystemError(key);
        }
    }
}
