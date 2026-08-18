# Contributing

鎰熻阿浣犲 dsh-web-remote 鐨勫叧娉紒

## 寮€鍙戠幆澧?
```bash
# 鍏嬮殕浠撳簱
git clone https://github.com/godchen520/dsh-web-remote.git
cd dsh-web-remote

# 瀹夎渚濊禆
pnpm install

# 璇硶妫€鏌?node --check lib/index.mjs

# 杩愯闆嗘垚娴嬭瘯
node test/test-dist.mjs
```

## 椤圭洰缁撴瀯

```
dsh-web-remote/
鈹溾攢鈹€ lib/
鈹?  鈹斺攢鈹€ index.mjs          # 涓绘彃浠朵唬鐮侊紙Host 绔?+ Client 娉ㄥ叆鑴氭湰锛?鈹溾攢鈹€ test/
鈹?  鈹斺攢鈹€ test-dist.mjs      # 闆嗘垚娴嬭瘯
鈹溾攢鈹€ docs/                   # 鎴浘
鈹溾攢鈹€ cordis.patch.yml        # DSH composition 閰嶇疆
鈹溾攢鈹€ package.json            # NPM 鍖呴厤缃?鈹斺攢鈹€ README.md
```

## 鎻愪氦瑙勮寖

- `feat:` 鏂板姛鑳?- `fix:` 淇
- `docs:` 鏂囨。
- `chore:` 鏋勫缓/宸ュ叿

## 鎻愪氦 PR

1. Fork 鏈粨搴?2. 鍒涘缓鐗规€у垎鏀細`git checkout -b feat/my-feature`
3. 鎻愪氦鏇存敼锛歚git commit -m 'feat: add xxx'`
4. 鎺ㄩ€佸垎鏀細`git push origin feat/my-feature`
5. 鍒涘缓 Pull Request

## 娴嬭瘯

淇敼 `lib/index.mjs` 鍚庯細

```bash
# 1. 璇硶妫€鏌?node --check lib/index.mjs

# 2. 澶嶅埗鍒拌繍琛屽壇鏈?cp lib/index.mjs $DSH_HOME/profiles/web/node_modules/dsh-web-remote/lib/index.mjs

# 3. 閲嶅惎 DSH 楠岃瘉
```

## 闂鍙嶉

浣跨敤 [Issue 妯℃澘](../../issues/new/choose) 鎻愪氦闂鎴栧姛鑳借姹傘€?