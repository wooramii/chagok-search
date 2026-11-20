const officialHost='www.osulloc.com';
const retailerHost='www.amoremall.com';
const noticeFields=['원재료표기','용량'];
const knownNotice=new Map([
 ['67354',{code:'411110000836',name:'제주 호지차 밀크티',count:10,url:'https://www.osulloc.com/kr/ko/shop/item/teashop/22013'}],
]);
const MAX_PAGE_BYTES=2_500_000;

export function httpsUrl(value,base){
 if(typeof value!=='string'||!value.trim()||value.length>3000)return '';
 try{
  const u=new URL(value,base);
  return u.protocol==='https:'&&!u.username&&!u.password&&!u.port?u.href:'';
 }catch{return '';}
}

// Keep untrusted search results from triggering requests to arbitrary hosts or paths.
function productUrl(input){
 const value=httpsUrl(input);
 if(!value)return '';
 const u=new URL(value);
 if(u.hostname==='osulloc.com')u.hostname=officialHost;
 if(u.hostname==='amoremall.com')u.hostname=retailerHost;
 if(u.hostname===officialHost&&/^\/kr\/ko\/shop\/item\/teashop\/\d{1,12}\/?$/.test(u.pathname)){
  u.search='';u.hash='';return u.href;
 }
 if(u.hostname!==retailerHost||u.pathname!=='/kr/ko/product/detail')return '';
 const sn=u.searchParams.get('onlineProdSn'),code=u.searchParams.get('onlineProdCode');
 if(!/^\d{1,12}$/.test(sn||'')||code&&!/^\d{1,18}$/.test(code))return '';
 u.search='';
 u.searchParams.set('onlineProdSn',sn);
 if(code)u.searchParams.set('onlineProdCode',code);
 u.hash='';
 return u.href;
}

const entities={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' ',times:'×',middot:'·'};
function decodeHtml(value){
 return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi,(whole,key)=>{
  if(key[0]!=='#')return Object.hasOwn(entities,key.toLowerCase())?entities[key.toLowerCase()]:whole;
  const number=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));
  return number>0&&number<=0x10ffff?String.fromCodePoint(number):whole;
 });
}
const flat=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const htmlText=value=>flat(decodeHtml(value.replace(/<br\s*\/?\s*>/gi,' ').replace(/<[^>]*>/g,'')));
function attributes(tag){
 const attrs=Object.create(null);
 for(const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+))/g)){
  attrs[match[1].toLowerCase()]=decodeHtml(match[2]??match[3]??match[4]);
 }
 return attrs;
}
function metadata(html){
 const data=new Map();
 for(const match of html.matchAll(/<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)){
  const {property,name,content}=attributes(match[0]),key=(property||name||'').toLowerCase();
  if(key&&content&&!data.has(key))data.set(key,flat(content));
 }
 return data;
}
function structuredProducts(html,url){
 const products=[];
 const localized=new Set();
 const retailerUrl=new URL(url);
 const groupId=retailerUrl.hostname===retailerHost?retailerUrl.searchParams.get('onlineProdSn'):'';
 const visit=node=>{
  if(Array.isArray(node)){for(const item of node)visit(item);return;}
  if(!node||typeof node!=='object')return;
  const types=[node['@type']].flat().map(type=>String(type).split(/[\/#]/).at(-1));
  if(types.includes('Product')||(types.includes('ProductGroup')&&groupId&&String(node.productGroupID??'')===groupId)){
   products.push(node);
  }
  if(types.includes('WebPage')&&/^ko(?:-|$)/i.test(node.inLanguage||'')&&typeof node.mainEntity?.['@id']==='string'){
   localized.add(httpsUrl(node.mainEntity['@id'],url));
  }
  if(node['@graph'])visit(node['@graph']);
  if(node.mainEntity)visit(node.mainEntity);
 };
 for(const match of html.matchAll(/<script\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi)){
  if((attributes(match[1]).type||'').toLowerCase()!=='application/ld+json'||match[2].length>250_000)continue;
  try{visit(JSON.parse(match[2]));}catch{}
 }
 return {products,localized};
}

function itemName(value){
 return flat(value).replace(/^\s*\[(?:오설록|osulloc)\]\s*/i,'')
  .replace(/\s*\(\s*(?:원산지|상세설명)[^)]*\)\s*/g,' ')
  .replace(/\s*\|\s*(?:아모레몰|오설록|amoremall|osulloc)(?:\s*공식몰)?\s*$/i,'').trim();
}
function nameKey(value){
 return itemName(value).replace(/^\s*(?:오설록|osulloc)\s+/i,'')
  .replace(/\d+(?:\.\d+)?\s*(?:kg|ml|g|l|입|개|포|스틱|ea)(?![a-z])/ig,'')
  .replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();
}
function pack(value){
 const name=itemName(value);
 const counts=[...name.matchAll(/(\d+)\s*(?:입|개|포|스틱|ea)(?![a-z])/gi)].map(m=>Number(m[1]));
 const multiplied=name.match(/(\d+(?:\.\d+)?)\s*(kg|ml|g|l)\s*[x×*]\s*(\d+)/i);
 if(multiplied)counts.push(Number(multiplied[3]));
 const measures=new Set([...name.matchAll(/(\d+(?:\.\d+)?)\s*(kg|ml|g|l)(?![a-z])/gi)]
  .map(m=>m[2].toLowerCase()+'|'+Number(m[1])));
 if(multiplied){
  const [,amount,unit,count]=multiplied;
  measures.delete(unit.toLowerCase()+'|'+Number(amount));
  measures.add(unit.toLowerCase()+'|'+Number(amount)*Number(count));
 }
 return {counts:new Set(counts),measures};
}
function contradicts(source,target){
 const a=pack(source),b=pack(target);
 return a.counts.size>1||b.counts.size>1||
  (a.counts.size&&b.counts.size&&[...a.counts].some(x=>!b.counts.has(x)))||
  (a.measures.size&&b.measures.size&&![...a.measures].some(x=>b.measures.has(x)));
}
function sameName(a,b){
 const ka=nameKey(a),kb=nameKey(b);
 return ka.length>=3&&ka===kb&&!contradicts(a,b);
}
const barcodeFor=node=>['gtin','gtin8','gtin12','gtin13','gtin14'].map(k=>String(node[k]??'')).find(x=>/^\d{8,14}$/.test(x))||'';
function imageUrl(input,url){
 const candidate=httpsUrl(typeof input==='object'&&input?input.contentUrl||input.url:input,url);
 return candidate&&!/\b(?:logo|banner|icon|sprite|no[-_]?image|placeholder)\b/i.test(new URL(candidate).pathname)?candidate:'';
}
function priceText(value,currency){
 const input=flat(value),code=flat(currency).toUpperCase();
 if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(input)||!/^(KRW|USD|EUR|GBP|JPY|CNY|CAD|AUD)$/.test(code))return '';
 const price=Number(input.replaceAll(',',''));
 if(!(price>0&&price<=10_000_000_000))return '';
 const display=new Intl.NumberFormat('ko-KR',{maximumFractionDigits:2}).format(price);
 return code==='KRW'?display+'원':display+' '+code;
}
function offerPrice(offers){
 const options=[offers].flat().filter(x=>x&&typeof x==='object');
 const prices=new Set(options.flatMap(offer=>{
  // Aggregate low/high prices represent unselected variants, so only use explicit offers.
  const value=priceText(offer.price,offer.priceCurrency);
  return value?[value]:[];
 }));
 return prices.size===1?[...prices][0]:'';
}
function officialTable(html){
 const rows=new Map();
 for(const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)){
  const cells=[...match[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]\s*>/gi)].map(m=>htmlText(m[1]));
  if(cells.length!==2||!cells[1]||cells[1].length>10000)continue;
  const key=cells[0].replace(/\s/g,'');
  if(!/^(상품명|제품명|포장단위별내용물의용량\(중량\)[,，]수량|내용량|원재료명및함량|원재료명)$/.test(key))continue;
  const previous=rows.get(key);
  rows.set(key,previous===undefined||previous===cells[1]?cells[1]:'');
 }
 return {name:rows.get('상품명')||rows.get('제품명')||'',volume:rows.get('포장단위별내용물의용량(중량),수량')||rows.get('내용량')||'',ingredients:rows.get('원재료명및함량')||rows.get('원재료명')||''};
}
function officialFromMarkdown(body){
 const lines=body.split(/\r?\n/).map(line=>line.replace(/^\s*\|\s*|\s*\|\s*$/g,'').replace(/\*\*/g,''));
 const entries=lines.filter(line=>line.includes('|')).map(line=>line.split('|').map(flat));
 const field=pattern=>{
  const values=new Set(entries.filter(row=>row.length===2&&pattern.test(row[0])&&row[1]&&row[1].length<=10000).map(row=>row[1]));
  return values.size===1?[...values][0]:'';
 };
 return {name:field(/^(?:상품명|제품명)$/),volume:field(/^(?:포장단위별\s*내용물의\s*용량\s*\(\s*중량\s*\)\s*[,，]\s*수량|내용량)$/),ingredients:field(/^원재료명(?:\s*및\s*함량)?$/)};
}
function labelImage(html,url,name){
 for(const match of html.matchAll(/<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)){
  const img=attributes(match[0]);
  if(!sameName(img.alt,name))continue;
  const image=imageUrl(img.src||img['data-src'],url);
  if(image)return image;
 }
 return '';
}
export function extractProductPage(html,url,expectedTitle,expectedBarcode=''){
 const supported=productUrl(url);
 const source=supported||httpsUrl(url);
 if(!source||typeof html!=='string')return null;
 const official=new URL(source).hostname===officialHost;
 const info=metadata(html),notice=official?officialTable(html):{};
 const {products,localized}=structuredProducts(html,source);
 const matches=products.filter(product=>sameName(product.name,expectedTitle)&&
  (!expectedBarcode||!barcodeFor(product)||barcodeFor(product)===expectedBarcode));
 const preferred=matches.filter(product=>localized.has(httpsUrl(product['@id'],source)));
 const structured=preferred.length===1?preferred[0]:matches.length===1?matches[0]:null;
 if((!supported||products.length)&&!structured)return null;
 const heading=[...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)].map(x=>htmlText(x[1])).find(x=>sameName(x,expectedTitle));
 const rawName=structured?.name||notice.name||info.get('og:title')||heading;
 const name=itemName(rawName);
 if(!name||!sameName(name,expectedTitle))return null;
 if(official&&notice.name&&sameName(notice.name,name)&&
  contradicts([notice.name,notice.volume].filter(Boolean).join(' '),expectedTitle))return null;
 const barcode=structured?barcodeFor(structured):'';
 if(expectedBarcode&&barcode&&barcode!==expectedBarcode)return null;
 const record={'제품명':name};
 const brand=flat(typeof structured?.brand==='string'?structured.brand:structured?.brand?.name);
 if(brand)record['브랜드']=brand.slice(0,150);
 const image=[structured?.image].flat().map(item=>imageUrl(item,source)).find(Boolean)||
  (sameName(info.get('og:title'),name)?imageUrl(info.get('og:image'),source):'')||
  (official?labelImage(html,source,name):'');
 if(image)record['이미지URL']=image;
 const price=offerPrice(structured?.offers)||priceText(info.get('product:price:amount'),info.get('product:price:currency'));
 if(price){record['판매가격']=price;record['판매가격확인일']=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());}
 if(official&&notice.name&&sameName(notice.name,name)){
  if(notice.volume)record['용량']=notice.volume;
  if(notice.ingredients)record['원재료표기']=notice.ingredients;
 }
 if(structured?.offers||price)record['구매URL']=source;
 return {record,barcode,source,identity:[name,notice.volume].filter(Boolean).join(' '),official};
}

async function fetchPage(fetcher,url){
 // Amoremall disallows general automated crawlers. Only read public Osulloc documents directly.
 const target=new URL(url);
 if(target.hostname!==officialHost||
  !(productUrl(url)||target.pathname==='/kr/ko/shop/search/main/product'))return '';
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3200);
 try{
  const response=await fetcher(url,{method:'GET',redirect:'manual',credentials:'omit',signal:controller.signal,
   headers:{Accept:'text/html,application/xhtml+xml', 'Accept-Language':'ko-KR,ko;q=0.9'}});
  if(!response.ok||!response.headers.get('Content-Type')?.match(/(?:text\/html|application\/xhtml\+xml)/i)||
   Number(response.headers.get('Content-Length')||0)>MAX_PAGE_BYTES||!response.body)return '';
  const chunks=[],reader=response.body.getReader();let length=0;
  for(;;){
   const {value,done}=await reader.read();
   if(done)break;
   length+=value.byteLength;
   if(length>MAX_PAGE_BYTES){await reader.cancel();return '';}
   chunks.push(value);
  }
  const decoder=new TextDecoder();
  return chunks.map(chunk=>decoder.decode(chunk,{stream:true})).join('')+decoder.decode();
 }catch{return '';}finally{clearTimeout(timer);}
}
function recordNotice(item,raw){
 const source=productUrl(item.record['제품정보출처']);
 if(!source||new URL(source).hostname!==officialHost)return null;
 const fields=officialFromMarkdown(raw||'');
 if(!fields.name||!sameName(fields.name,item.record['제품명']))return null;
 return {source,record:{'제품명':itemName(fields.name),'용량':fields.volume,'원재료표기':fields.ingredients},
  identity:[fields.name,fields.volume].filter(Boolean).join(' '),barcode:'',official:true};
}
function canSupplement(retailer,official,known){
 if(!official?.official||!sameName(retailer.record['제품명'],official.record['제품명']))return false;
 const retailIdentity=[retailer.identity||retailer.record['제품명'],retailer.record['용량']].filter(Boolean).join(' ');
 if(contradicts(retailIdentity,official.identity))return false;
 if(retailer.barcode&&official.barcode)return retailer.barcode===official.barcode;
 const a=pack(retailIdentity),b=pack(official.identity);
 if(known){
  // The product IDs are a verified exact SKU cross-reference. Require the same official package.
  return sameName(known.name,official.record['제품명'])&&b.counts.size===1&&b.counts.has(known.count)&&
   (!a.counts.size||a.counts.has(known.count));
 }
 return !!((a.counts.size&&b.counts.size&&[...a.counts].some(x=>b.counts.has(x)))||
  (a.measures.size&&b.measures.size&&[...a.measures].some(x=>b.measures.has(x))));
}
function isOsullocRetailer(item){
 const url=productUrl(item.record['제품정보출처']);
 return !!url&&new URL(url).hostname===retailerHost&&
  /^(?:오설록|osulloc)$/i.test(flat(item.record['브랜드'])||(/\[\s*오설록\s*\]|\bosulloc\b|오설록/i.test(item.record['제품명'])?'오설록':''));
}

function amoremallProviderData(raw,result,source,expectedTitle){
 // Use the existing provider's content without re-fetching Amoremall.
 if(!raw)return null;
 const title=raw.split(/\r?\n/).map(line=>flat(line.replace(/^\s*#+\s+/,'').replace(/\*\*/g,'')))
  .find(line=>sameName(line,expectedTitle));
 if(!title)return null;
 const record={'제품명':itemName(title)},url=new URL(source);
 const code=url.searchParams.get('onlineProdCode');
 const rawImages=[...raw.matchAll(/!\[[^\]]*\]\((https:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g)].map(m=>m[1]);
 if(Array.isArray(result?.images))rawImages.push(...result.images.slice(0,20).map(image=>image?.url));
 if(code)for(const item of rawImages){
  const image=httpsUrl(item);
  if(!image)continue;
  const u=new URL(image);
  if(u.hostname==='images-kr.amoremall.com'&&u.pathname.startsWith('/products/'+code+'/'+code+'_01.')){
   record['이미지URL']=image;break;
  }
 }
 const quantity=[...raw.matchAll(/제품\s*수량\s*감소\s*(?:\[Input\]\s*)?(\d+)\s*(?:\[Input\]\s*)?제품\s*수량\s*증가/g)];
 if(quantity.length&&quantity.every(match=>Number(match[1])===1)){
  const totals=new Set();
  for(const line of raw.split(/\r?\n/)){
   const match=flat(line.replace(/\*\*/g,'')).match(/^총\s*상품가\s*([\d,]+)\s*원(?:\s+혜택\s*적용가\s*[\d,]+\s*원)?$/);
   const price=match&&priceText(match[1],'KRW');
   if(price)totals.add(price);
  }
  if(totals.size===1){
   record['판매가격']=[...totals][0];
   record['판매가격확인일']=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());
  }
 }
 if(/장바구니|구매하기/.test(raw))record['구매URL']=source;
 return {record,source,identity:record['제품명'],barcode:'',official:false};
}

async function findOsullocNotice(item,load){
 const title=item.record['제품명'];
 const declared=pack([title,item.record['용량']].filter(Boolean).join(' '));
 if(declared.counts.size!==1&&declared.measures.size!==1)return null;
 const query=itemName(title).replace(/\s+\d+\s*(?:입|개|포|스틱)\s*$/i,'').slice(0,100);
 if(!query)return null;
 const search=new URL('/kr/ko/shop/search/main/product','https://'+officialHost);
 search.search=new URLSearchParams({isSet:'N',p:'0',q:query,searchType:'product',size:'24',sort:'ranked'}).toString();
 const html=await load(search.href);
 const exact=new Set();
 for(const match of html.matchAll(/<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)){
  const candidate=attributes(match[0]);
  if(!candidate.class?.split(/\s+/).includes('product_link')||!sameName(candidate['data-track-name'],title))continue;
  const href=productUrl(httpsUrl(candidate.href,search));
  if(href&&new URL(href).hostname===officialHost)exact.add(href);
 }
 if(exact.size!==1)return null;
 const url=[...exact][0];
 return extractProductPage(await load(url),url,title,item.record['바코드']||'');
}

export async function enrichProductCandidates(items,fetcher,rawResults=[]){
 const pages=new Map();
 const byUrl=new Map(rawResults.filter(result=>result&&typeof result==='object').map(result=>[httpsUrl(result.url),result]));
 const load=url=>{
  if(!pages.has(url))pages.set(url,fetchPage(fetcher,url));
  return pages.get(url);
 };
 const candidates=items.map(item=>{
  const source=productUrl(item.record['제품정보출처']);
  const url=source&&new URL(source);
  let known=url?.hostname===retailerHost?knownNotice.get(url.searchParams.get('onlineProdSn')):null;
  if(known&&((url.searchParams.get('onlineProdCode')&&url.searchParams.get('onlineProdCode')!==known.code)||
   !sameName(known.name,item.record['제품명'])))known=null;
  if(url?.hostname===officialHost)load(source);
  if(known&&noticeFields.some(key=>!item.record[key]))load(known.url);
  return {item,source,known};
 });
 const inspected=await Promise.all(candidates.map(async ({item,source,known})=>{
  const result=byUrl.get(item.record['제품정보출처']);
  const raw=typeof result?.raw_content==='string'?result.raw_content.slice(0,500_000):'';
  let page=null;
  if(source){
   if(pages.has(source))page=extractProductPage(await load(source),source,item.record['제품명'],item.record['바코드']);
   if(!page&&new URL(source).hostname===retailerHost){
    page=extractProductPage(raw,source,item.record['제품명'],item.record['바코드'])||
     amoremallProviderData(raw,result,source,item.record['제품명']);
   }
  }else if(raw.includes('application/ld+json'))page=extractProductPage(raw,item.record['제품정보출처'],item.record['제품명'],item.record['바코드']);
  const rawNotice=recordNotice(item,raw);
  const linked=known&&pages.has(known.url)?extractProductPage(await load(known.url),known.url,known.name,item.record['바코드']):null;
  return {item,source,page,rawNotice,known,linked};
 }));
 const official=inspected.flatMap(x=>[x.page,x.rawNotice]).filter(x=>x?.official);
 // At most one supplemental public search per user search. Existing verified matches come first.
 const needsOfficialSearch=inspected.find(({item,page,known})=>{
  const record={...item.record,...page?.record};
  const candidate={...item,record};
  const matched={record,identity:page?.identity,barcode:page?.barcode||record['바코드']||''};
  return !known&&isOsullocRetailer(candidate)&&noticeFields.some(key=>!record[key]&&
   !official.some(x=>x.record[key]&&canSupplement(matched,x,null)));
 });
 if(needsOfficialSearch){
  const item=needsOfficialSearch.item,record={...item.record,...needsOfficialSearch.page?.record};
  const result=await findOsullocNotice({...item,record},load);
  if(result)official.push(result);
 }
 return inspected.map(({item,source,page,rawNotice,known,linked})=>{
  const record={...item.record},fieldSources={},officialFields=[];
  for(const key of Object.keys(record)){
   if(record[key]&&key!=='제품정보출처')fieldSources[key]=record['제품정보출처'];
  }
  const set=(key,value,url,fromOfficial)=>{
   if(!value)return;
   record[key]=value;fieldSources[key]=url;
   if(fromOfficial&&noticeFields.includes(key)&&!officialFields.includes(key))officialFields.push(key);
  };
  if(page)for(const [key,value] of Object.entries(page.record))set(key,value,page.source,page.official);
  if(rawNotice)for(const key of noticeFields)if(!officialFields.includes(key))set(key,rawNotice.record[key],rawNotice.source,true);
  if(page?.official&&source)for(const key of noticeFields)if(record[key]&&!officialFields.includes(key))set(key,record[key],source,true);
  if(page?.official||rawNotice)return {...item,record,fieldSources,officialFields};
  const matched={record,identity:page?.identity,barcode:page?.barcode||record['바코드']||''};
  if(known||isOsullocRetailer({...item,record}))for(const key of noticeFields){
   if(record[key])continue;
   const allowed=[linked,...official].filter(x=>x?.record[key]&&canSupplement(matched,x,known&&x.source===known.url?known:null));
   const values=new Set(allowed.map(x=>x.record[key]));
   if(values.size===1)set(key,allowed[0].record[key],allowed[0].source,true);
  }
  return {...item,record,fieldSources,officialFields};
 });
}
