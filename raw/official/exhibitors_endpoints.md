# WAIC 2026 参展商 / 展台 / 展区 API 逆向文档

抓取时间：2026-07-16。补 endpoints.md 未覆盖的「展商名录」。数据来自前端页面
`https://www.worldaic.com.cn/exhibitors`（Nuxt 路由 `/exhibitors`）实抓 XHR。

## 关键发现：展商数据在另一个后端（不是 api2025）

`/exhibitors` 页面的展商/产品数据**不走** `api2025.worldaic.com.cn`，而是走独立的
**服务端 `servicer.worldaic.com.cn/waic/show/`**。api2025 上那个
`ExhibitionMerchantDirectories/queryExhibitionMerchantDirectoriesList` 只是一个**残缺的旧接口**
（仅 302 家、字段只有 名称/展台号/logo，且只含世博展览馆 H1/H2/H3，漏掉 H4 和其它三馆），**不要用它**。
以 servicer 为准。

### 请求头（同 api2025，无强反爬，无签名/token）
```
Referer: https://www.worldaic.com.cn/
Origin:  https://www.worldaic.com.cn
Content-Type: application/json
Accept: application/json, text/plain, */*
```
响应包裹：`{"code":0,"data":{...},"msg":"","msgEn":""}`（注意 code 是数字 `0`，不是 api2025 的字符串 `"0000"`）。

---

## 核心接口

### A. 展商名录（企业级）★★★ 主力
`POST https://servicer.worldaic.com.cn/waic/show/info/page`

请求体：
```json
{"pageNo":1,"pageSize":100,"exhibitionYear":2026}
```
- **`pageSize` 上限 100**（>100 返回 `data:null`）。`total`=1020，需翻 11 页。
- 分页字段：`data.list[]` + `data.total`（无 pages 字段，自己算）。
- 可能支持行业/场馆/关键词过滤参数（未逐一验证；因为已一次拉全 1020 条并自带归属，无需过滤）。

每条企业字段：
| 字段 | 含义 |
|---|---|
| enterpriseCode | 企业 ID（唯一，1020 条全不重复）|
| enterpriseName / enterpriseNameEn | 企业名（中/英）|
| enterpriseLogos[] | logo，`attachmentPath`=完整图片 URL（904/1020 有）|
| booths[] | **展台数组**（可多个）：boothNumber(如 H1-C107)、boothLocationName(展馆区域，如「世博展览馆H2」)、boothLocationNameEn、boothVenueName(场馆，如「世博展览馆」)、boothVenueNameEn、boothLocationCode/boothVenueCode |
| industryLevelOneCode / industryLevelOneName / ...En | **一级行业分类**（可多值逗号拼接；18 家为空）|
| businessScope / ...Code / ...En | 国民经济营业范围（如「信息传输、软件和信息技术服务业」）|
| partnerLevelName / ...Code / ...En | 合作等级（多数为空，见下）|
| roleName / roleCode / roleNamesEn | 角色：展商 / 论坛主办方 / 展商,论坛主办方 |
| enterpriseIntroductionCn / enterpriseIntroductionEn | **企业简介全文**（中/英；993/1020 有中文）|
| enterpriseCharacteristics / ...Code / ...En | 企业性质（多数空）|
| exhibitionId(=4) / exhibitionYear(=2026) / exhibitionSession(=9) | 届次 |

### B. 展品目录（产品级）★★
`POST https://servicer.worldaic.com.cn/waic/show/product/published-page`
请求体同上（`{"pageNo","pageSize<=100","exhibitionYear":2026}`）。`total`=1341，翻 14 页。
字段：productCode, productName/En, enterpriseCode, enterpriseName/En, enterpriseLogoPath,
industries[]（industryPrimaryCode/Name/En）, boothCode, boothNumber,
productDescriptionCn/En, isNewProduct, isShowInBulletin, isBrochureApproved 等布尔位。

### C. 一级行业字典 ★
`POST https://servicer.worldaic.com.cn/waic/show/product/published-industry-list`  body `{}`
返回 25 个一级行业（industryPrimaryCode `VO_INDUSTRY_L1_01`..`_25` / Name / NameEn）：
核心技术、具身智能、智能终端、智能驾驶、智慧医疗、智慧城市、工业互联与智能制造、金融科技、
人才与教育、伦理治理、文娱艺术与元宇宙、制造业、政府/机构、城市管理、租赁业与商业服务业、
投资机构、交通运输仓储和邮政、住宿和餐饮、建筑业、房地产、批发和零售、采矿业、农林牧渔、
电力热力燃气及水、其他。

### D. 展区（沿用 api2025，见 endpoints.md §6）
- `GET api2025.../exhibitionArea/list` → 4 展区。
- `GET api2025.../exhibitionArea/detail/{uuid}/inside` → 展区详情（页面实际用 `/inside`，不是 `/home`）。

### 旧/残缺接口（不推荐）
- `POST api2025.../ExhibitionMerchantDirectories/queryExhibitionMerchantDirectoriesList`
  （= `getH5MerchantList`，二者同源）：total 302，字段仅 uuid/enterpriseName/En/logoUrl(全空)/boothNumber，
  只含世博展览馆 H1/H2/H3+6 家待定，缺 H4/世博中心/西岸/张江。过滤参数 `exhibitionAreaUuidList`/`companyLevelList` **被后端忽略**（传了 total 不变）。
- `GET api2025.../onLineCompany/getH5CompanyDetail/{uuid}`、`getH5MerchantDetail/{uuid}`：对上述 uuid 均返回 `code:0002 未匹配到对应数据`，**未上线/无数据**。

---

## 抓取产物：exhibitors.json
结构：`{_meta, industryPrimaryList[25], exhibitors[1020], products[1341]}`。
展商去重后 1020 家（enterpriseCode 唯一）。抓取脚本 pageSize=100 翻页，全量落地。

### 分布速览（1020 家）
- **按场馆**（多馆企业重复计）：世博展览馆 676、张江科学会堂 102、西岸国际会展中心 64、世博中心 52；**150 家尚未分配展台**（booths 为空）。
- **按展馆区域**：世博展览馆 H4=288、H3=160、H1=147、H2=75、中厅 8；西岸 64；张江-海科厅 59、张江厅 44；世博中心 52；未定 150。
- **每企业展台数**：0 个=150，1 个=843，2 个=24，3 个=3。
- **按角色**：纯展商 789、展商+论坛主办方 129、纯论坛主办方 93、空 9。（真正参展 918 家含展台归属，93 家仅论坛主办方多无展台。）
- **按一级行业**：核心技术 390、具身智能 169、其他 62、制造业 61、工业互联与智能制造 51、智能终端 50、政府/机构 39、人才与教育 34、金融科技 25、智慧医疗 24……（18 家无行业；部分多行业逗号拼接）。
- **按合作等级**：多数空(753)；FT初创项目 146、精英合作伙伴 33、卓越合作伙伴 22、OPC创业项目 21、战略合作伙伴 20、创投生态合作伙伴 13、参展单位 7、品牌赞助商 3、办会单位 2。
- 字段完整度：有 logo 904、有中文简介 993。
