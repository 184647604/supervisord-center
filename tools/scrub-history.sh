#!/bin/sh
# 从**全部历史**里抹掉真实令牌。
#
# 为什么要在 push 之前做：仓库从没推过，现在改写历史是零成本的。
# 一旦推上去，这个令牌就永远留在 GitHub 的历史里，只能 force-push
# 才能清掉 —— 而 force-push 会打断任何已经 clone 的人。
#
# 替换成占位符而不是删除，是为了让历史仍然可读（能看出那里原本有个令牌）。
#
# 由 tools/scrub-history.ps1 调用，通常不用手工执行。

set -e

OLD_TOKEN='REDACTED-TOKEN'
OLD_TAILNET='YOUR-NODE.YOUR-TAILNET.ts.net'
NEW_TOKEN='REDACTED-TOKEN'
NEW_TAILNET='YOUR-NODE.YOUR-TAILNET.ts.net'

git filter-branch -f --tree-filter "
  find . -type f -not -path './.git/*' -print0 2>/dev/null | while IFS= read -r -d '' f; do
    if grep -qI '$OLD_TOKEN' \"\$f\" 2>/dev/null; then
      sed -i 's/$OLD_TOKEN/$NEW_TOKEN/g' \"\$f\"
    fi
    if grep -qI '$OLD_TAILNET' \"\$f\" 2>/dev/null; then
      sed -i 's/$OLD_TAILNET/$NEW_TAILNET/g' \"\$f\"
    fi
  done
" --tag-name-filter cat -- --all

# 提交信息里的令牌也要抹掉（0df5f01 的正文里有一句）
git filter-branch -f --msg-filter "
  sed 's/$OLD_TOKEN/$NEW_TOKEN/g'
" --tag-name-filter cat -- --all
