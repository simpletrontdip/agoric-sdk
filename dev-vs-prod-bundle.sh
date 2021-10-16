#! /bin/sh
# put this in the top of your agoricdev-5.1

cd $(dirname "$0")

for kind in dev prod; do
  echo "Installing $kind dependencies"
  case $kind in
  dev) yarn install --frozen-lockfile ;;
  prod) yarn install --frozen-lockfile --production ;;
  esac

  for count in 1 2; do
    SWINGSET_WRITE_BUNDLE=$PWD/bundle-$kind-$count.json \
      make -C packages/cosmic-swingset scenario3-setup scenario3-run
  done
done

shasum -a 256 bundle-*.json
