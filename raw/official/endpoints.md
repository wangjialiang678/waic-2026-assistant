# WAIC 2026 官网数据 API 逆向文档

抓取时间：2026-07-16。数据来自 https://www.worldaic.com.cn/ （Nuxt SPA）。

## 基础信息

- **API Base（2026 仍复用 2025 域名）**：`https://api2025.worldaic.com.cn`
- **路径前缀**：`/official/website/`（JS 中 `t="official/website/"`）
- **静态 JS 分片**：`https://static.worldaic.com.cn/2026/web/static/_nuxt/`，API 层定义在 `DC9E4HP7.js`
- **图片/封面 CDN**：`https://downloadprod.worldaic.com.cn/...` 与 `https://static.worldaic.com.cn/media/...`
- **前端论坛详情页**：`https://www.worldaic.com.cn/events/forum/{uuid}`
- **前端论坛列表页**：`https://www.worldaic.com.cn/events/forum`

### 必需请求头（否则可能被 CloudWAF 拦）
```
Referer: https://www.worldaic.com.cn/
Origin:  https://www.worldaic.com.cn
Content-Type: application/json      # POST 时
Accept: application/json, text/plain, */*
```
未见强反爬（无签名校验，`token/sign/timestamp` header 可选）。服务器为 CloudWAF，正常直连即可。

### 统一响应包裹
```json
{ "code":"0000", "msg":"success", "data":..., "success":true,
  "size":N, "total":N, "pages":N }   // 列表接口带分页字段
```
`code:"0000"` 成功；`code:"9999"` 内部错误。

---

## 核心接口

### 1. 论坛/活动列表（主力接口）★
`POST /official/website/officialFront/queryOfficialFrontForumList`

请求体：
```json
{ "forumTime": ["2026-07-17"], "pageNum":1, "pageSize":5, "queryLocation":"home" }
```
- `forumTime`：日期数组，可传多天 `["2026-07-17","2026-07-18","2026-07-19","2026-07-20"]`；**留空或省略 = 返回全部 174 条**。
- `queryLocation:"home"`：**限首页精选**（每天仅 5~6 条）；**去掉此字段才返回全量**。
- `pageSize`：实测可到 1000（一次性拉全）。
- 返回字段（列表级，见下方"字段说明"）：uuid, name/nameEn, type/typeEn, addr, startTime, endTime, forumDate, forumAddr(场馆), forumTag(标签), coverImgUrl, desc/descEn, 视频直播 URL 等。**列表不含嘉宾/议程**。

### 2. 论坛详情（含嘉宾+议程）★★
`GET /official/website/officialForum/queryOfficialForumByUuid/{uuid}`

比列表多出关键字段：
- `guestVisitList[]`：嘉宾/演讲者（name / leaderName / company / position / introduce / guestCategory / guestTagList / photoImgUrl）。**注意 VIP 领导的姓名放在 `leaderName`，普通嘉宾放在 `name`。**
- `scheduleList[]`：议程条目（scheduleDate, startTime, endTime, sessionName, speechTheme, `speechGuest`=逗号分隔的嘉宾 uuid，指向 guestVisitList 里的 uuid）。
- `forumOrgStructureReqs[]`：主办/承办机构（name/nameEn, type）。
- `forumTagList[]`：主题标签；`fullForumTime`；`agenda/agendaEn`（本届多为 null，议程走 scheduleList）；`showGuests/showAgenda`（是否公开）。

### 3. 论坛筛选参数
`GET /official/website/officialForum/queryOfficialForumParam`
返回 `dateList`（4 天）、`typeList`（分论坛/主题论坛/全体会议/同期活动）、`addressList`（11 个场馆）。

### 4. 论坛详情（另一个，列表结构+视频）
`GET /official/website/officialFront/queryOfficialFrontForum/{uuid}` — 字段同列表项，含直播/回放视频 URL，无嘉宾议程。

### 5. 全局嘉宾列表（推荐嘉宾，1087 人）
`POST /official/website/officialFront/queryOfficialFrontGuestList`
请求体 `{"pageNum":1,"pageSize":500}`（`recommendSts:0` 会过滤成 0，别加）。分页 pageSize≤1000。
字段：uuid, name/nameEn, company/companyEn, position/positionEn, photoImgUrl, soundbite, identityDescription。**此列表是独立的"推荐嘉宾墙"，不带 forumUuid，与论坛不直接关联；论坛-嘉宾关联要用接口 2 的 guestVisitList。**
单个嘉宾：`GET .../officialFront/queryOfficialFrontGuest/{uuid}`

### 6. 展区
- `GET /official/website/exhibitionArea/list` → 4 个展区（世博中心 / 世博展览馆 / 徐汇西岸国际会展中心 / 张江科学会堂），字段 uuid, title, titleEn。
- `GET /official/website/exhibitionArea/detail/{uuid}/home` → 展区详情。
- `GET /official/website/exhibition/highlight/list` → 展览亮点（本届返回 null）。
- `GET /official/website/officialFront/queryOfficialExhibitionType` → 展览类型。

### 7. 特色活动 / 同期活动
- `POST /official/website/characteristicActivity/queryCharacteristicActivityList` `{"pageNum":1,"pageSize":300}` → total 3。
- `POST /official/website/innovate/event/announcement/list` → 空(0)。
- `POST /official/website/talents/event/announcement/list` → 空(0)。
- 注：大量"同期活动"其实已并入接口 1 的 forum 列表（type=同期活动，24 条）。

### 8. 五大板块（Circle）—— 均"coming soon"未上线
API key 与前端 slug 映射：
| 前端 slug | API key | 接口 |
|---|---|---|
| ai-gravity | ai | `/circle/ai/introductionDetail`、`/circle/ai/eventList`(POST)、`/circle/ai/eventYear`、`/circle/ai/eventDetail/{uuid}`、`/circle/ai/enterpriseList` |
| connect | connect | `/circle/connect/introductionDetail`、`/circle/connect/eventList` … |
| future-tech | tech | `/circle/tech/introductionDetail`、`/circle/tech/eventList`、`/circle/tech/newsList`、`/circle/tech/themeEventsList`、`/circle/tech/investorstList`、`/circle/tech/partnersList` … |
| waic-up | up | `/circle/up/introductionDetail`、`/circle/up/eventList`、`/circle/up/guestList`、`/circle/up/journalsList`、`/circle/up/exclusivePerspectiveList` |
| young | young | `/circle/young/introductionDetail`、`/circle/young/eventList`、`/circle/young/eventYear` |

抓取时前端 `/circle/*` 全部 302→`/circle/coming-soon`；所有 `eventList` total=0，`introductionDetail` 多为空。**唯一有内容的是 `circle/connect/introductionDetail`，但返回的却是 AI GRAVITY 文案（后端数据录入错位）。**

### 9. 其他已发现但未重点抓取的接口
新闻：`officialFront/queryOfficialFrontJournalismList`(POST)、`journalism/queryJournalism/{id}`；合作伙伴：`partners/queryPartnersList`(POST)、`dict/queryListByType/partners_type`；Banner：`officialFront/getOfficialFrontBanner`、`officialBanner/queryOfficialBannerList`；会议介绍：`conference/introduction/home`、`conference/introduction/detail`；倒计时：`queryDistanceTimeNum`；观展指南：`conference/guide/detail/{id}`；专题报道：`special/report/list`；采购公告：`purchase/notice/list`；企业/商户：`onLineCompany/getH5CompanyDetail/{id}`、`ExhibitionMerchantDirectories/...`；文件下载：`officialFile/queryOfficialFileList`；搜索：`{n}search/query`、`{n}search/index/{e}`（不同 base）。完整清单见本目录 `all_endpoints.txt`。

---

## 论坛记录字段说明（forums_raw.json，合并了列表+详情）

| 字段 | 含义 |
|---|---|
| uuid | 论坛 ID（拼详情页 URL：`worldaic.com.cn/events/forum/{uuid}`）|
| name / nameEn | 论坛标题（中/英）|
| type / typeEn | 类别：主题论坛/分论坛/全体会议/同期活动 |
| forumDate | 日期 YYYY-MM-DD |
| startTime / endTime | 起止时间 HH:MM |
| addr / addrEn | 具体厅室（如"银厅A"）|
| forumAddr / forumAddrEn | 所属场馆（如"世博中心"）|
| forumTag / forumTagList | 主题标签 |
| desc / descEn | 论坛简介（中/英，全文）|
| coverImgUrl | 封面图 URL |
| guestVisitList[] | 嘉宾/演讲者（name/leaderName, company, position, introduce, guestCategory）|
| scheduleList[] | 议程（scheduleDate, startTime, endTime, sessionName, speechTheme, speechGuest=嘉宾uuid）|
| forumOrgStructureReqs[] | 主办/承办机构 |
| chinaVideoUrl* / outsideVideoUrl* / playStraightSpot | 直播/回放视频（本届多为 null）|
| showGuests / showAgenda / recommendSts / sortWeight | 展示与排序控制位 |

---

## 学术分站（waica2026）
`https://waica2026.worldaic.com.cn/program/program-glance/` —— **不是 API 驱动，是 Drupal/静态服务端渲染**，无 XHR。日程直接嵌在 HTML `<table>` 里，用 curl 拉 HTML 解析即可。已解析入 `academic_program.json`（3 张 At-A-Glance 按天表 + 6 张 Main Track Session 论文级详情表）。
