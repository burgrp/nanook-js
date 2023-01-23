NANOOK main board js code

## DEVICE.FARM

## Locally build Docker image

Install binfmt
```sh
docker run --rm --privileged docker/binfmt:820fdd95a9972a5308930a2bdfb8573dd4447ad3
```

Build the image
```shell
docker buildx build --platform linux/arm/v7 -t burgrp/nanook --load .
docker push burgrp/nanook
```

Update image digest in docker-compose.yml.

## Deploy Docker image to device

Make sure docker-compose.yml contains valid image digest to the build above.

```sh
defa install device-id /dev/your-sd-card --wifi=ssid:password --ssh - --dto $PWD/dto
defa proxy <deviceId> -- docker-compose up --remove-orphans -d
```
