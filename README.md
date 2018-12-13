# BitmovinYospaceModule

This integration complete encapsulate the usage of Yospace. After creating the player it can be used like a normal [BitmovinPlayer](https://bitmovin.com/docs/player) instance.

## Usage

### Basic Setup
1. Build the script by running `gulp build-prod`
2. Include `bitmovinplayer-yospace.min.js` **after** `yo-ad-management.min.js` in your HTML document
3. Create an instance of `BitmovinYospacePlayer`
```js
var playerConfig = {
  key: 'YOUR-PLAYER-KEY'
};

var playerContainer = document.getElementById('player');
var yospacePlayer = bitmovin.player.ads.yospace.BitmovinYospacePlayer(playerContainer, playerConfig);

// Create the UI afterwards (see https://github.com/bitmovin/bitmovin-player-ui for details)
bitmovin.playerui.UIFactory.buildDefaultUI(yospacePlayer);

// Load a new yospace source
var source = {
  hls: 'your yospace url',

  // The type of the asset
  assetType: bitmovin.player.ads.yospace.YospaceAssetType.LINEAR
  // one of:
  // - bitmovin.player.ads.yospace.YospaceAssetType.LINEAR
  // - bitmovin.player.ads.yospace.YospaceAssetType.VOD
  // - bitmovin.player.ads.yospace.YospaceAssetType.LINEAR_START_OVER
};

yospacePlayer.load(source);
```

### Advanced Setup

#### Policy

As there can be different rules for different use-cases we provide a `BitmovinYospacePlayerPolicy` interface which can be implemented.
In this policy you could define which actions should be allowed during playback.

You can set the policy by calling: (should be called right after initialization)

```js
yospacePlayer.setPolicy(...); // pass in your policy object which implements BitmovinYospacePlayerPolicy
```

We also provide a default policy.  
See [BitmovinYospacePlayerPolicy](./src/ts/BitmovinYospacePlayerPolicy.ts) for more details.

#### Config
You can pass a third optional parameter to the player constructor:
```js
var yospaceConfig = {
  debug: true
};
...
var yospacePlayer = new bitmovin.player.ads.yospace.BitmovinYospacePlayer(playerContainer, conf, yospaceConfig);

```

## Limitations

- Since EMSG is not supported in Safari we can't track ads in live streams for now.
- When the very last post-roll ad is skipped we are showing another frame then when it finished playing. 