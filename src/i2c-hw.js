let Bus;

module.exports = config => {
    return {
        async open(address) {
            try {
                if (!Bus) {
                    Bus = require("i2c-bus-promised").Bus;
                }
                const bus = new Bus(parseInt(address || 0));
                console.info("Opening I2C bus...");
                await bus.open();

                return {
                    async read(address, length) {
                        let buffer = Buffer.alloc(length);
                        let read = await bus.read(parseInt(address), length, buffer);
                        if (read !== length) {
                            throw `Could read only ${read} bytes from ${length}`;
                        }
                        return Uint8Array.from(buffer);
                    },

                    async write(address, data) {
                        let buffer = Buffer.from(data);
                        let written = await bus.write(parseInt(address), data.length, buffer);
                        if (written !== data.length) {
                            throw `Could write only ${read} bytes from ${data.length}`;
                        }
                    },

                    async close() {
                        console.info("Closing I2C bus...");
                        await bus.close();
                    }
                }
            } catch (e) {
                console.error("Error wile opening I2C driver", e);
                throw e;
            }
        }
    }
}