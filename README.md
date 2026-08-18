# dsh-web-remote

[![npm version](https://img.shields.io/badge/npm-dsh--web--remote-blue)](https://github.com/godchen520/dsh-web-remote)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH Compatible](https://img.shields.io/badge/DSH-1.x-brightgreen)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](../../pulls)

> 鎵嬫満 / 澶栫綉杩滅▼璁块棶 DeepSeek Harness锛圖SH锛夌殑鎻掍欢銆傞殢鏃堕殢鍦伴€氳繃寰俊鎴栨祻瑙堝櫒鎺у埗浣犵殑 DSH銆?
## 鉁?鍔熻兘浜偣

| 鍔熻兘 | 璇存槑 |
|------|------|
| 馃寪 **鍏綉璁块棶** | Cloudflare Quick Tunnel锛屾棤闇€鍏綉 IP銆佹棤闇€娉ㄥ唽锛宍cloudflared` 缂哄け鏃惰嚜鍔ㄤ笅杞?|
| 馃摗 **灞€鍩熺綉鐩磋繛** | HTTP + HTTPS 鐩磋繛锛圚TTPS 鑷姩鐢熸垚鑷鍚嶈瘉涔︼紝闆堕厤缃級 |
| 馃敀 **瀹夊叏璁よ瘉** | 姣忔鍚姩鐢熸垚闅忔満浠ょ墝锛汬ttpOnly Cookie锛涘眬鍩熺綉鍙厤 token |
| 鈿?**鎬ц兘鍔犻€?* | 鍙嶅悜浠ｇ悊鑷姩 gzip 鍘嬬缉锛屽ぇ鍘嗗彶浼氳瘽鍔犺浇鏇村揩 |
| 馃摫 **渚ц竟鏍忓浘鏍?* | 鎵嬫満蹇嵎鎸夐挳甯搁┗宸︿笅瑙掞紝鍒锋柊涓嶆秷澶?|
| 馃 **寰俊鏈哄櫒浜?* | iLink 鍗忚鐩磋繛寰俊锛屾敮鎸?AI 瀵硅瘽銆佷細璇濇帶鍒躲€佹ā鍨嬪垏鎹?|
| 馃挰 **QQ 鏈哄櫒浜?* | NapCat OneBot 11 鍙嶅悜 WebSocket锛堟柦宸ヤ腑锛?|

## 馃殌 蹇€熷紑濮?
**涓夋涓婃墜锛?*

```bash
# 1. 瀹夎鎻掍欢锛堝湪 DSH profile 鐩綍鎵ц锛?cd $DSH_HOME/profiles/web
pnpm add github:godchen520/dsh-web-remote

# 2. 娉ㄥ唽 bundle锛堢紪杈?package.json锛?# 鍦?"dsh.profile.bundles" 鏁扮粍涓坊鍔?"dsh-web-remote"

# 3. 閲嶅惎 DSH
dsh web
```

鍚姩鍚庨〉闈㈠乏涓嬭鍑虹幇 馃摫 鍥炬爣 鈫?鐐瑰嚮鎵撳紑杩滅▼闈㈡澘銆?
## 馃摳 鎴浘

**蹇嵎鎸夐挳**锛堥〉闈㈠乏涓嬭锛夛細

![蹇嵎鎸夐挳](docs/quick-button.png)

**杩滅▼闈㈡澘**锛堝叕缃?/ 灞€鍩熺綉鍒囨崲銆佷竴閿鍒堕摼鎺ャ€佷簩缁寸爜銆佸惎鍔?/ 鍋滄锛夛細

![杩滅▼闈㈡澘](docs/remote-screenshot.png)

## 馃搵 瀹夎鏂瑰紡

### 鏂瑰紡涓€锛欸itHub 鐩存帴瀹夎锛堟帹鑽愶級

```bash
cd $DSH_HOME/profiles/web
pnpm add github:godchen520/dsh-web-remote
```

鍦?`package.json` 鐨?`dsh.profile.bundles` 鏁扮粍涓坊鍔?`"dsh-web-remote"`锛岄噸鍚?DSH銆?
> `--config.minimumReleaseAge=0` 鍙粫杩?pnpm 11 鏂板寘鍙戝竷骞撮緞鏍￠獙锛堝闇€瑕侊級銆?
### 鏂瑰紡浜岋細鎵嬪姩 patch

鎶婃湰鍖呮斁鍏?profile 鐨?`node_modules`锛岀劧鍚庡湪 `cordis.patch.yml` 杩藉姞锛?
```yaml
- insert:
    - id: web-remote
      name: 'dsh-web-remote'
```

> bundle 鏂瑰紡闇€閲嶅惎锛沜ordis.patch.yml 鏂瑰紡浼氳 HMR 鐑姞杞姐€?
## 鈿欙笍 閰嶇疆

鍏ㄩ儴鍙€夛紝涓嶉厤缃嵆寮€绠卞嵆鐢ㄣ€傚湪 `cordis.patch.yml` 閲岃鐩栵細

| 鍙傛暟 | 榛樿鍊?| 璇存槑 |
|------|--------|------|
| `targetPort` | `3080` | DSH 鑷韩绔彛 |
| `httpPortStart` | `3081` | 灞€鍩熺綉 HTTP 璧峰绔彛锛堣嚜鍔ㄨ烦杩囧崰鐢級 |
| `httpsPortStart` | `3082` | 灞€鍩熺綉 HTTPS 璧峰绔彛 |
| `qqPortStart` | `3001` | QQ OneBot 妗ヨ捣濮嬬鍙?|
| `cloudflaredPath` | `''` | 鎸囧畾 cloudflared 璺緞锛涚暀绌鸿嚜鍔ㄦ帰娴?/ 鑷姩涓嬭浇 |
| `pfxPath` | `''` | 鎸囧畾 PFX 璇佷功锛涚暀绌鸿嚜鍔ㄧ敓鎴愯嚜绛惧悕 |
| `pfxPass` | `''` | PFX 瀵嗙爜 |
| `toolsDir` | `''` | 宸ュ叿涓庤瘉涔︾紦瀛樼洰褰曪紱鐣欑┖浣跨敤 `$DSH_HOME/tools` |
| `autoStart` | `true` | 鎻掍欢鍔犺浇鍗宠嚜鍔ㄥ惎鍔?|
| `lanOpen` | `true` | 灞€鍩熺綉鍏?token锛堢缃戞潵婧愭斁琛岋級 |

## 馃摫 浣跨敤鏂规硶

1. 鍚姩鍚庨〉闈㈠乏涓嬭鍑虹幇 馃摫 鍥炬爣
2. 鐐瑰嚮鍥炬爣 鈫?闈㈡澘鏄剧ず杩愯鐘舵€佸拰閾炬帴
3. 鎵嬫満娴忚鍣ㄦ墦寮€閾炬帴鍗冲彲璁块棶 DSH

**鍏綉**锛歚https://xxx.trycloudflare.com/?token=...`
**灞€鍩熺綉**锛歚https://192.168.x.x:3082`锛堝悓 Wi-Fi锛涢粯璁ゅ厤 token锛?
## 馃 寰俊鏈哄櫒浜?
閫氳繃寰俊鐩存帴鎺у埗 DSH锛屾敮鎸侊細

**杩滅▼鎺у埗鍛戒护锛?*
- `/閾炬帴` 鈥?鑾峰彇鍏綉閾炬帴锛堟湭鍚姩鑷姩寮€鍚級
- `/鍋滄杩滅▼` 鈥?鍏抽棴杩滅▼鏈嶅姟

**浼氳瘽绠＄悊锛?*
- `/浼氳瘽鍒楄〃` 鈥?鍒楀嚭鎵€鏈変細璇?- `/閫夋嫨 N` 鈥?閫変腑绗?N 涓細璇?- `/褰撳墠浼氳瘽` 鈥?鏌ョ湅閫変腑浼氳瘽鍚嶇О
- `/鍘嗗彶鍐呭` 鈥?鏌ョ湅浼氳瘽鏈€杩戣緭鍑?
**妯″瀷鍒囨崲锛?*
- `/褰撳墠妯″瀷` 鈥?鏌ョ湅褰撳墠浣跨敤鐨勬ā鍨?- `/鍒囨崲妯″瀷` 鈥?鍒楀嚭鎵€鏈夋ā鍨嬪苟鍒囨崲
- `/閫夊己搴?N` 鈥?璁剧疆鎬濊€冨己搴?
**瀵硅瘽锛?*
- 鐩存帴鍙戦€佸唴瀹?鈫?鑷姩鍙戝埌閫変腑鐨勪細璇濆苟鍥炰紶缁撴灉
- 鏈€夋嫨浼氳瘽鏃舵彁绀哄厛閫夋嫨

## 鉂?甯歌闂

**Q: 鍏綉閾炬帴鎵撳紑鎻愮ず"涓嶅畨鍏?锛?*
A: 杩欐槸 HTTPS 鑷鍚嶈瘉涔︾殑棰勬湡琛屼负銆傛墜鏈烘祻瑙堝櫒閫夋嫨銆岀户缁闂€嶅嵆鍙€侲dge 闇€鍏抽棴"澧炲己瀹夊叏鎬?銆?
**Q: 閲嶅惎 DSH 鍚庨摼鎺ュ彉浜嗭紵**
A: 鍏綉闅ч亾姣忔閲嶅惎浼氱敓鎴愭柊鍦板潃锛岃繖鏄甯歌涓恒€傚井淇＄粦瀹氱殑 token 浼氳嚜鍔ㄦ寔涔呭寲鎭㈠銆?
**Q: cloudflared 涓嬭浇澶辫触锛?*
A: 棣栨鍚姩闇€瑕佽仈缃戜笅杞?cloudflared锛堢害 10MB锛夛紝涔嬪悗澶嶇敤缂撳瓨銆傚彲鎵嬪姩涓嬭浇鏀惧埌 `toolsDir` 鐩綍銆?
**Q: 寰俊鎵爜鍚庢柇寮€锛?*
A: 閲嶅惎 DSH 鍚庡井淇′細鑷姩閲嶈繛锛坱oken 宸叉寔涔呭寲锛夈€傚浠嶆柇寮€锛岄噸鏂板彂閫?`/閾炬帴` 鎵爜缁戝畾銆?
## 馃摑 鏇存柊鏃ュ織

鏌ョ湅 [CHANGELOG.md](CHANGELOG.md) 浜嗚В鐗堟湰鏇存柊鍘嗗彶銆?
## 馃 璐＄尞

娆㈣繋璐＄尞锛佽鏌ョ湅 [CONTRIBUTING.md](.github/CONTRIBUTING.md) 浜嗚В寮€鍙戝拰鎻愪氦娴佺▼銆?
## 馃搫 License

[MIT](LICENSE)
