module.exports = async config => {

    let dashboard = {
        client: __dirname + "/dashboard-client",
        events: {
            registerChanged: {},
            systemErrorsChanged: {}
        },
        api: {
            dashboard: {
                async getRegisters() {
                    return config.controller.registers;
                },

                async getSystemErrors() {
                    return config.controller.systemErrors;
                },

                async setRegister(regName, value) {
                    await config.controller.registers[regName].set(value);
                },

                async setColdWaterPump(state) {
                    await config.controller.setColdWaterPump(state);
                },

                async setHotWaterPump(state) {
                    await config.controller.setHotWaterPump(state);
                },

                async setCompressorRelay(state) {
                    await config.controller.setCompressorRelay(state);
                },

                async setCompressorRamp(ramp) {
                    await config.controller.setCompressorRamp(ramp);
                },

                async eevRun(fullSteps, fast) {
                    await config.controller.eevRun(fullSteps, fast);
                },

                async clearSystemError(key) {
                    await config.controller.clearSystemError(key);
                },

                async start() {
                    await config.controller.start();
                },

                async stop() {
                    await config.controller.stop();
                },

                async setEevPosition(position) {
                    await config.controller.setEevPosition(position);
                },

                async setRgbLed(led) {
                    await config.controller.setRgbLed(led);
                },

                async setMqttBroker(broker) {
                    console.info(broker);
                }
            }
        }
    }

    config.controller.watchSystemErrors(systemErrors => {
        dashboard.events.systemErrorsChanged(systemErrors);
    });

    Object.values(config.controller.registers).forEach(register => {
        register.watch(() => {
            dashboard.events.registerChanged(register);
        })
    });

    return dashboard;
}