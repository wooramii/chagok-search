// Cloudflare Worker 전용. 실제 키는 Settings → Secrets에 저장합니다.
const ALLOWED_ORIGIN='https://wooramii.github.io';
const text=(value,max=2000)=>typeof value==='string'?value.trim().slice(0,max):'';
function httpsUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}}
function validQuery(mode,value){
 const query=text(value,101).normalize('NFKC').replace(/\s+/g,' ').trim();
 if(mode==='name')return query.length>=2&&query.length<=100?query:'';
 if(mode!=='barcode'||!/^(?:\d{8}|\d{12,14})$/.test(query))return '';
 let sum=0;for(let i=query.length-2,w=3;i>=0;i--,w=w===3?1:3)sum+=Number(query[i])*w;
 return (10-sum%10)%10===Number(query.at(-1))?query:'';
}
function labeledValue(body,labels){
 const values=new Set();for(const line of body.split(/\r?\n/)){
  const match=line.replace(/\*\*/g,'').trim().match(new RegExp('^(?:'+labels.join('|')+')\\s*[:：]\\s*(.{1,200})$','i'));
  if(match&&!/[<>\[\]{}]/.test(match[1]))values.add(match[1].trim());
 }return values.size===1?[...values][0]:'';
}
function sourceField(body,labels,max=10000){
 const lines=body.replace(/\*\*/g,'').split(/\r?\n/),values=new Set(),pattern=new RegExp('^[ \\t|>#•-]*(?:'+labels.join('|')+')\\s*[:：|]\\s*(.*?)\\s*\\|?\\s*$','i');
 for(let i=0;i<lines.length;i++){const match=lines[i].match(pattern);if(!match)continue;let value=match[1].trim();if(!value){value=(lines[i+1]||'').trim();if(!value||/^(?:#|!|\||[-*] )|^[^:：]{1,30}[:：]/.test(value))continue;}if(value&&!/[<>]/.test(value)&&value.length<=max)values.add(value);}
 return values.size===1?[...values][0]:'';
}
function fieldUrl(value){const markdown=value.match(/^\[[^\]]*\]\((https:\/\/[^\s)]+)\)$/);return httpsUrl(markdown?markdown[1]:value);}
function productImage(result,body,name){
 const labeled=fieldUrl(sourceField(body,['제품\\s*이미지(?:\\s*(?:URL|주소))?','상품\\s*이미지(?:\\s*(?:URL|주소))?','Product image(?: URL)?','Image URL'],2000));if(labeled)return labeled;
 const normalize=value=>String(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
 const identity=normalize(name);if(identity.length<4)return '';
 const images=[];for(const match of body.matchAll(/!\[([^\]]*)\]\((https:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g))images.push({url:match[2],description:match[1]});
 if(Array.isArray(result.images))images.push(...result.images.slice(0,20).filter(x=>x&&typeof x==='object'));
 for(const image of images){const description=String(image.description||'');if(/logo|icon|banner|로고|아이콘|배너/i.test(description))continue;const alt=normalize(description);if(alt.includes(identity)&&httpsUrl(image.url))return httpsUrl(image.url);}
 return '';
}
export function matchingBarcodeField(rawContent,query){
 if(!validQuery('barcode',query)||typeof rawContent!=='string')return false;
 const body=rawContent.normalize('NFKC').replace(/[*_`]/g,'');
 // 검색 제목·URL·검색어 반복은 증거가 아닙니다. 원문의 바코드 필드를 대조합니다.
 const fields=/^[ \t|>#•-]*(?:유통\s*바코드|상품\s*바코드|바코드|barcode(?:\s*(?:number|no\.?))?|bar\s+code|ean(?:[ -]?(?:8|13))?|gtin(?:[ -]?(?:8|12|13|14))?|upc(?:[ -]?[ae])?|國際條碼|国际条码|商品條碼|商品条码|條碼|条码|JAN(?:コード)?)[ \t]*[:：=|]?[ \t]*(?:\r?\n[ \t]*)?([0-9][0-9 \t-]*)(?=$|[|,;()<>])/gim;
 const codes=new Set();for(const match of body.matchAll(fields)){
  const code=match[1].replace(/[ \t-]/g,'');if(validQuery('barcode',code))codes.add(code);
 }
 // 여러 상품/규격의 서로 다른 바코드가 함께 있는 페이지도 제외합니다.
 return codes.size===1&&codes.has(query);
}
export function productCandidates(results,mode,query){
 const seen=new Set();return (Array.isArray(results)?results:[]).slice(0,10).flatMap(result=>{
  const url=httpsUrl(result.url),title=text(result.title,200),body=text(result.raw_content||result.content,30000);
  if(!url||!title||seen.has(url))return [];
  if(mode==='barcode'&&!matchingBarcodeField(result.raw_content,query))return [];
  seen.add(url);
  // 검색 결과에 명시된 값만 사용합니다. 브랜드·원재료·이미지를 추측하지 않습니다.
  const record={'제품명':labeledValue(body,['제품명','상품명','Product name'])||title,'제품정보출처':url};
  const brand=labeledValue(body,['브랜드','Brand']);if(brand)record['브랜드']=brand;
  const volumes=[...title.matchAll(/\b\d+(?:\.\d+)?\s*(?:ml|mL|ML|kg|KG|g|G|L|ℓ)\b/g)].map(m=>m[0]);
  if(new Set(volumes).size===1)record['용량']=volumes[0];
  const ingredients=sourceField(body,['원재료(?:명|표기)?(?:\\s*및\\s*함량)?','원료명(?:\\s*및\\s*함량)?','Ingredients?(?: list)?']);if(ingredients)record['원재료표기']=ingredients;
  const image=productImage(result,body,record['제품명']);if(image)record['이미지URL']=image;
  const price=sourceField(body,['판매가(?:격)?','상품가격','Sale price','Price'],100);if(price&&/(?:\d[\d,.]*\s*(?:원|KRW|USD|EUR|GBP)|[₩$€£]\s*\d)/i.test(price)){record['판매가격']=price;record['판매가격확인일']=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());}
  const buy=fieldUrl(sourceField(body,['구매(?:URL|링크|주소)','판매(?:URL|링크|주소)','Purchase URL','Buy URL'],2000));if(buy)record['구매URL']=buy;else if(record['판매가격']&&/장바구니|바로\s*구매|구매하기|add to cart|buy now/i.test(body))record['구매URL']=url;
  const barcodeMatch=mode==='barcode'?{code:query,method:'source-field'}:undefined;
  if(barcodeMatch)record['바코드']=query;
  return [{record,...(barcodeMatch?{barcodeMatch}:{}),summary:text(result.content,450),warning:barcodeMatch?'원문의 바코드 필드가 입력 번호와 일치합니다. 제품명·포장도 확인하세요.':'원문의 제품명·브랜드 표기 또는 검색 제목과 표기된 용량을 사용합니다. 실제 포장과 확인하세요.'}];
 }).slice(0,5);
}
export function createHandler(fetcher=(...args)=>fetch(...args)){
 return async function handle(request,env){
  const origin=request.headers.get('Origin'),headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
  if(origin===ALLOWED_ORIGIN)headers['Access-Control-Allow-Origin']=origin;
  const reply=(status,data)=>new Response(JSON.stringify(data),{status,headers});
  if(origin!==ALLOWED_ORIGIN)return reply(403,{error:'origin'});
  if(new URL(request.url).pathname!=='/search')return reply(404,{error:'route'});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'600'}});
  if(request.method!=='POST')return reply(405,{error:'method'});
  if(!env.TAVILY_API_KEY||!env.TURNSTILE_SECRET_KEY)return reply(503,{error:'configuration'});
  if(!request.headers.get('Content-Type')?.startsWith('application/json'))return reply(400,{error:'content-type'});
  let input;try{
   if(Number(request.headers.get('Content-Length')||0)>4096)return reply(413,{error:'size'});
   // Bound streaming input too: Content-Length can be absent or dishonest.
   const reader=request.body?.getReader();if(!reader)return reply(400,{error:'body'});
   let size=0,chunks=[];for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();return reply(413,{error:'size'});}chunks.push(value);}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}input=JSON.parse(new TextDecoder().decode(bytes));
  }catch{return reply(400,{error:'json'});}
  const query=validQuery(input?.mode,input?.query),token=text(input?.token,2049);if(!query||!token||token.length>2048)return reply(400,{error:'input'});
  let context='';if(input.context!=null){if(typeof input.context!=='object'||Array.isArray(input.context))return reply(400,{error:'context'});for(const key of ['name','brand','category'])if(input.context[key]!=null&&(typeof input.context[key]!=='string'||input.context[key].length>100))return reply(400,{error:'context'});if(input.context.category&&!['티백','RTD','분말','잎차'].includes(input.context.category))return reply(400,{error:'context'});context=[input.context.name,input.context.brand,input.context.category].filter(Boolean).join(' ');}
  try{
   const verification=await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret:env.TURNSTILE_SECRET_KEY,response:token}),signal:AbortSignal.timeout(8000)});
   if(!verification.ok)return reply(502,{error:'verification-service'});
   const verified=await verification.json();if(!verified.success||verified.hostname!==new URL(ALLOWED_ORIGIN).hostname||verified.action!=='tea_search')return reply(403,{error:'verification'});
   const response=await fetcher('https://api.tavily.com/search',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+env.TAVILY_API_KEY},body:JSON.stringify({query:input.mode==='barcode'?['"'+query+'"',context].filter(Boolean).join(' '):query,search_depth:'basic',topic:'general',max_results:5,include_answer:false,include_raw_content:'markdown',include_images:true,include_image_descriptions:true,auto_parameters:false}),signal:AbortSignal.timeout(18000)});
   if(!response.ok)return reply([429,432,433].includes(response.status)?429:502,{error:'search-service'});
   const data=await response.json();if(!Array.isArray(data.results))return reply(502,{error:'search-format'});
   return reply(200,{items:productCandidates(data.results,input.mode,query)});
  }catch(error){return reply(error.name==='TimeoutError'||error.name==='AbortError'?504:502,{error:'upstream'});}
 };
}
export default {fetch:createHandler()};
