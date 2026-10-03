/** Pure deterministic region/weighted-mesh sampling. Canvas2D matrices and points are y-up. */
const radians = degrees => degrees * Math.PI / 180;
export function multiplyMatrices(a, b) {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
export function transformPoint(m, x, y) { return { x:m[0]*x+m[2]*y+m[4], y:m[1]*x+m[3]*y+m[5] }; }
function matrix(x = 0, y = 0, rotation = 0, sx = 1, sy = 1) {
  const r = radians(rotation), c = Math.cos(r), s = Math.sin(r); return [c*sx, s*sx, -s*sy, c*sy, x, y];
}
export function sampleTimeline(keys = [], time, base = 0) {
  if (!keys.length || time < (keys[0].time ?? 0)) return null;
  let previous = keys[0];
  for (let i=1;i<keys.length;i++) {
    const current = keys[i];
    if (time < (current.time ?? 0)) {
      const weight = previous.curve === 'stepped' ? 0 : (time-(previous.time ?? 0))/((current.time ?? 0)-(previous.time ?? 0));
      return Object.fromEntries([...new Set([...Object.keys(previous), ...Object.keys(current)])].filter(key => !['time','curve'].includes(key)).map(key => {
        const value = previous[key] ?? current[key];
        return [key, typeof value === 'number' ? (previous[key] ?? base) + ((current[key] ?? base)-(previous[key] ?? base))*weight : value];
      }));
    }
    previous = current;
  }
  return { ...previous };
}
function latest(keys = [], time) { let result; for (const key of keys) { if ((key.time ?? 0)>time) break; result=key; } return result; }
function orderAt(slots, offsets) {
  if (!offsets?.length) return slots.map(slot => slot.name);
  const result = new Array(slots.length), unchanged = []; let original = 0;
  for (const entry of offsets) {
    const index = slots.findIndex(slot=>slot.name===entry.slot);
    while (original<index) unchanged.push(slots[original++].name);
    result[original+entry.offset]=slots[original++].name;
  }
  while(original<slots.length) unchanged.push(slots[original++].name);
  for(let i=result.length-1;i>=0;i--) if(result[i]===undefined) result[i]=unchanged.pop();
  return result;
}
function weightedVertices(attachment, bones) {
  const result = []; let cursor = 0;
  for (let vertex = 0; vertex < attachment.uvs.length / 2; vertex++) {
    const count = attachment.vertices[cursor++]; let x = 0, y = 0;
    for (let i = 0; i < count; i++) {
      const bone = bones[attachment.vertices[cursor++]], localX = attachment.vertices[cursor++], localY = attachment.vertices[cursor++], weight = attachment.vertices[cursor++];
      const point = transformPoint(bone.matrix, localX, localY); x += point.x * weight; y += point.y * weight;
    }
    result.push({ x, y });
  }
  return result;
}

/** Map a texture's unit square (top-down UV) into each sampled mesh triangle.
 * Both the browser Canvas and server thumbnail renderer use this same mapping.
 */
export function skeleton2dMeshTriangles(slot, { seamPadding = 0 } = {}) {
  if (slot.type !== 'mesh') return [];
  const edges = new Map(), edgeKey = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  if (seamPadding > 0) for (let i = 0; i < slot.triangles.length; i += 3) for (let edge = 0; edge < 3; edge++) {
    const key = edgeKey(slot.triangles[i + edge], slot.triangles[i + (edge + 1) % 3]); edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  const result = [];
  for (let i = 0; i < slot.triangles.length; i += 3) {
    const indices = slot.triangles.slice(i, i + 3), points = indices.map(index => slot.vertices[index]);
    const uv = indices.map(index => [slot.uvs[index * 2], slot.uvs[index * 2 + 1]]);
    const du1 = uv[1][0] - uv[0][0], dv1 = uv[1][1] - uv[0][1], du2 = uv[2][0] - uv[0][0], dv2 = uv[2][1] - uv[0][1];
    const determinant = du1 * dv2 - du2 * dv1;
    const dx1 = points[1].x - points[0].x, dy1 = points[1].y - points[0].y, dx2 = points[2].x - points[0].x, dy2 = points[2].y - points[0].y;
    const a = (dx1 * dv2 - dx2 * dv1) / determinant, b = (dy1 * dv2 - dy2 * dv1) / determinant;
    const c = (dx2 * du1 - dx1 * du2) / determinant, d = (dy2 * du1 - dy1 * du2) / determinant;
    const matrix = [a, b, c, d, points[0].x - a * uv[0][0] - c * uv[0][1], points[0].y - b * uv[0][0] - d * uv[0][1]];
    let clipPoints = points, edgePadding=[0,0,0];
    if (seamPadding > 0) {
      // Canvas antialiases each clip independently, which otherwise leaves
      // half-alpha cracks inside an opaque mesh. Expand shared edges by less
      // than one output pixel; never expand the outer silhouette.
      const winding = Math.sign(dx1 * dy2 - dy1 * dx2);
      const lines = points.map((point, edge) => {
        const next = points[(edge + 1) % 3], nx = (next.y - point.y) * winding, ny = (point.x - next.x) * winding;
        const pad = edges.get(edgeKey(indices[edge], indices[(edge + 1) % 3])) > 1 ? seamPadding : 0;edgePadding[edge]=pad;
        return { nx, ny, offset: nx * point.x + ny * point.y + Math.hypot(nx, ny) * pad };
      });
      clipPoints = points.map((point, i) => {
        const a = lines[(i + 2) % 3], b = lines[i], determinant = a.nx * b.ny - b.nx * a.ny;
        if (Math.abs(determinant) < 1e-12) return point;
        const intersection = { x: (a.offset * b.ny - b.offset * a.ny) / determinant, y: (a.nx * b.offset - b.nx * a.offset) / determinant };
        // Acute/deforming faces can have a miter hundreds of pixels long even
        // for subpixel padding. Limit the join while staying on any unpadded
        // exterior edge, so a narrow elbow triangle cannot leak the texture.
        const dx = intersection.x - point.x, dy = intersection.y - point.y;
        const amount = Math.min(1, seamPadding * 2 / Math.max(Math.hypot(dx, dy), 1e-12));
        return { x: point.x + dx * amount, y: point.y + dy * amount };
      });
    }
    result.push({ indices, points, clipPoints, matrix, edgePadding });
  }
  return result;
}

// Prove coverage by horizontal slabs, rather than area alone: overlapping
// triangles can have unit total area while leaving a hole. A complete affine
// texture needs no triangle-union clip, whose T-junction rasterization can
// otherwise introduce tiny cracks even though the geometry has no gap.
const squareCoverageCache=new WeakMap();
function coversUnitSquare(slot,epsilon) {
  const cached=squareCoverageCache.get(slot.triangles);
  if(cached&&cached.epsilon===epsilon&&cached.uvs.length===slot.uvs.length&&cached.triangles.length===slot.triangles.length&&cached.uvs.every((v,i)=>v===slot.uvs[i])&&cached.triangles.every((v,i)=>v===slot.triangles[i]))return cached.result;
  const result=proveUnitSquareCoverage(slot,epsilon);
  squareCoverageCache.set(slot.triangles,{uvs:slot.uvs.slice(),triangles:slot.triangles.slice(),epsilon,result});return result;
}
function proveUnitSquareCoverage(slot,epsilon) {
  if (slot.uvs.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return false;
  const ys = [...new Set(slot.uvs.filter((_, i) => i % 2))].sort((a,b)=>a-b);
  if (ys[0] !== 0 || ys.at(-1) !== 1) return false;
  for (let row=1;row<ys.length;row++) {
    if (ys[row]-ys[row-1] <= epsilon) continue;
    const top=ys[row-1],bottom=ys[row],y=(top+bottom)/2,intervals=[];
    for (let i=0;i<slot.triangles.length;i+=3) {
      const points=slot.triangles.slice(i,i+3).map(index=>[slot.uvs[index*2],slot.uvs[index*2+1]]), edges=[];
      for (let edge=0;edge<3;edge++) {
        const a=points[edge],b=points[(edge+1)%3];
        if ((a[1]<y && b[1]>y)||(b[1]<y && a[1]>y))edges.push(at=>a[0]+(b[0]-a[0])*(at-a[1])/(b[1]-a[1]));
      }
      if(edges.length===2){edges.sort((a,b)=>a(y)-b(y));intervals.push([edges[0](top),edges[1](top),edges[0](bottom),edges[1](bottom)]);}
    }
    // Inside one slab each triangle's interval ends are linear. Require a
    // connected chain whose adjacent intervals overlap at BOTH slab ends;
    // then every link also overlaps at every interior y. A midpoint alone
    // can falsely fill a triangular hole. This proof is conservative.
    const reached=new Set(),queue=[];
    for(let i=0;i<intervals.length;i++)if(intervals[i][0]<=epsilon&&intervals[i][2]<=epsilon){reached.add(i);queue.push(i);}
    let rightReached=false;
    for(let at=0;at<queue.length;at++){
      const a=intervals[queue[at]];if(a[1]>=1-epsilon&&a[3]>=1-epsilon){rightReached=true;break;}
      for(let i=0;i<intervals.length;i++)if(!reached.has(i)){
        const b=intervals[i];if(a[0]<=b[1]+epsilon&&b[0]<=a[1]+epsilon&&a[2]<=b[3]+epsilon&&b[2]<=a[3]+epsilon){reached.add(i);queue.push(i);}
      }
    }
    if(!rightReached)return false;
  }
  return true;
}
// An integer-aligned native-size image needs no resampling. Some Canvas
// backends still apply their high-quality cubic filter at 1:1, blurring the
// source even through an identity transform. Keep smoothing for every actual
// scale, subpixel placement and rotation.
function drawTexture(context,image,x,y,width,height,sourceRect){
  const matrix=context.getTransform?.(),iw=image.naturalWidth||image.width,ih=image.naturalHeight||image.height;
  const near=(a,b)=>Math.abs(a-b)<1e-10;
  const aligned=matrix&&iw>0&&ih>0&&near(matrix.b,0)&&near(matrix.c,0)
    &&near(Math.abs(matrix.a*width/(sourceRect?.[2]??iw)),1)&&near(Math.abs(matrix.d*height/(sourceRect?.[3]??ih)),1)
    &&near(matrix.e+matrix.a*x,Math.round(matrix.e+matrix.a*x))
    &&near(matrix.f+matrix.d*y,Math.round(matrix.f+matrix.d*y));
  const smoothing=context.imageSmoothingEnabled;
  if(aligned)context.imageSmoothingEnabled=false;
  try{if(sourceRect)context.drawImage(image,...sourceRect,x,y,width,height);else context.drawImage(image,x,y,width,height);}finally{if(aligned)context.imageSmoothingEnabled=smoothing;}
}
function drawMeshTexture(context,image,triangles,slot,fullRectangle=false){
  const iw=image.naturalWidth||image.width,ih=image.naturalHeight||image.height;
  if(fullRectangle||!(iw>0&&ih>0)){drawTexture(context,image,0,0,1,1);return;}
  let minU=1,minV=1,maxU=0,maxV=0;
  for(const triangle of triangles)for(const i of triangle.indices){
    const u=slot.uvs[i*2],v=slot.uvs[i*2+1];
    minU=Math.min(minU,u);minV=Math.min(minV,v);maxU=Math.max(maxU,u);maxV=Math.max(maxV,v);
  }
  // Submit only this face's source neighborhood. Some native Canvas backends
  // leak unrelated pixels through nested complex clips when given a whole
  // texture for every face. Two source pixels retain the resampling kernel;
  // the original posed clip still owns the precise silhouette.
  const x=Math.max(0,Math.floor(minU*iw)-2),y=Math.max(0,Math.floor(minV*ih)-2);
  const w=Math.min(iw,Math.ceil(maxU*iw)+2)-x,h=Math.min(ih,Math.ceil(maxV*ih)+2)-y;
  if(w>0&&h>0)drawTexture(context,image,x/iw,y/ih,w/iw,h/ih,[x,y,w,h]);
}
function drawAffineGroup(context, triangles, affine, image, fullRectangle=false, padded=false,slot) {
  context.save();
  if (!fullRectangle) {
    const key=(a,b)=>a<b?`${a},${b}`:`${b},${a}`,edges=new Map();
    if(padded)for(const t of triangles)for(let e=0;e<3;e++){const k=key(t.indices[e],t.indices[(e+1)%3]);edges.set(k,(edges.get(k)??0)+1);}
    context.beginPath();
    for (const triangle of triangles) {
      const [a,b,c]=triangle.points,positive=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)>=0;
      context.moveTo(a.x,a.y);context.lineTo(positive?b.x:c.x,positive?b.y:c.y);context.lineTo(positive?c.x:b.x,positive?c.y:b.y);context.closePath();
      // The union already eliminates its internal edges. Pad only a shared
      // edge against a differently transformed group; padding internal
      // diagonals can protrude through an otherwise unpadded outer corner.
      if(padded)for(let e=0;e<3;e++){
        const pad=triangle.edgePadding[e];if(!pad||edges.get(key(triangle.indices[e],triangle.indices[(e+1)%3]))>1)continue;
        const p=triangle.points[e],q=triangle.points[(e+1)%3],length=Math.hypot(q.x-p.x,q.y-p.y),sign=positive?1:-1;
        const nx=(q.y-p.y)/length*sign*pad,ny=(p.x-q.x)/length*sign*pad;
        const strip=[p,q,{x:q.x+nx,y:q.y+ny},{x:p.x+nx,y:p.y+ny}];
        if(positive)strip.reverse();
        context.moveTo(strip[0].x,strip[0].y);for(const v of strip.slice(1))context.lineTo(v.x,v.y);context.closePath();
      }
    }
    context.clip();
  }
  context.transform(...affine);drawMeshTexture(context,image,triangles,slot,fullRectangle);context.restore();
}
function posedOutline(slot, triangles) {
  const edges=new Map();
  for(const triangle of triangles){
    const ids=triangle.indices.slice(),[a,b,c]=triangle.points;
    const worldArea=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
    if(!worldArea)continue;if(worldArea<0)ids.reverse();
    for(let e=0;e<3;e++){
      const from=ids[e],to=ids[(e+1)%3],key=`${from},${to}`,reverse=`${to},${from}`,opposite=edges.get(reverse);
      if(opposite){if(opposite.count===1)edges.delete(reverse);else opposite.count--;}
      else{const previous=edges.get(key);if(previous)previous.count++;else edges.set(key,{from,to,count:1});}
    }
  }
  // Opposite directed edges cancel algebraically. Same-direction copies at
  // folds remain: the resulting balanced multigraph has exactly the winding
  // sum of the positive triangle paths, including holes and folded overlaps.
  const next=new Map();
  for(const edge of edges.values()){if(!next.has(edge.from))next.set(edge.from,[]);for(let i=0;i<edge.count;i++)next.get(edge.from).push(edge.to);}
  const loops=[];
  while(next.size){
    const start=next.keys().next().value,loop=[];let at=start;
    do{loop.push(slot.vertices[at]);const exits=next.get(at);if(!exits?.length)return null;const to=exits.pop();if(!exits.length)next.delete(at);at=to;}while(at!==start);
    if(loop.length>=3)loops.push(loop);
  }
  return loops;
}
/** Draw into an already configured y-up Canvas2D context; no DOM ownership. */
export function drawSkeleton2dSlot(context, slot, image) {
  if (slot.type === 'mesh') {
    const transform = context.getTransform?.(), scale = transform ? Math.max(Math.hypot(transform.a, transform.b), Math.hypot(transform.c, transform.d)) : 1;
    const triangles = skeleton2dMeshTriangles(slot, { seamPadding: 0.75 / Math.max(scale, 0.000001) });
    // Prefer a broad face: a very thin clipped face magnifies roundoff when
    // solving the affine map. Triangle order is an occlusion decision, not a
    // suitable numerical calibration for the complete texture.
    const broadest=triangles.reduce((best,t)=>{
      const [a,b,c]=t.indices.map(i=>[slot.uvs[i*2],slot.uvs[i*2+1]]),area=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]));
      return !best||area>best.area?{triangle:t,area}:best;
    },null);
    let affine = broadest?.triangle.matrix;
    // Test the mapped vertices directly. Solving an affine matrix on a sliver
    // magnifies harmless weighted-coordinate roundoff, even when every posed
    // vertex still lies on the same image transform to subpixel precision.
    const affineVertices=affine?.every(Number.isFinite)&&slot.vertices.every((point,i)=>{
      const mapped=transformPoint(affine,slot.uvs[i*2],slot.uvs[i*2+1]);
      return Math.max(Math.abs(mapped.x-point.x),Math.abs(mapped.y-point.y))*Math.max(scale,1)<=1e-8;
    });
    if (affineVertices) {
      // A rigid mesh samples one image transform. Drawing its padded faces
      // separately would composite translucent source pixels more than once.
      // Clip to their exact union instead: shared edges disappear, while
      // concavities and holes remain clipped. Normalize winding so triangles
      // with opposite index order cannot cancel under Canvas's nonzero rule.
      // Domain partitioning may discard numerically collapsed faces. Allow
      // only seams narrower than 0.001 output pixel (and 1e-6 UV), rather than
      // sending an otherwise complete image through an AA triangle-union clip.
      const pixelSpan=Math.max(Math.hypot(affine[0],affine[1]),Math.hypot(affine[2],affine[3]))*Math.max(scale,1);
      const fullRectangle=coversUnitSquare(slot,Math.min(1e-6,.001/Math.max(pixelSpan,1)));
      if(fullRectangle){
        const at=(u,v)=>{const i=slot.vertices.findIndex((_,i)=>slot.uvs[i*2]===u&&slot.uvs[i*2+1]===v);return i<0?null:slot.vertices[i];};
        const a=at(0,0),b=at(1,0),c=at(0,1);
        if(a&&b&&c)affine=[b.x-a.x,b.y-a.y,c.x-a.x,c.y-a.y,a.x,a.y];
      }
    drawAffineGroup(context,triangles,affine,image,fullRectangle,false,slot);
      return;
    }
    // Shared-edge padding is only an antialiasing aid. Clip it to the actual
    // posed union so a multi-face miter cannot escape the outer silhouette.
    context.save();context.beginPath();
    // Cancel opposite internal edges before clipping; retain edge multiplicity
    // at folds. This has the same winding sum without thousands of redundant
    // interior triangle paths for the rasterizer to intersect on every draw.
    const outline=posedOutline(slot,triangles);
    if(outline)for(const loop of outline){context.moveTo(loop[0].x,loop[0].y);for(const point of loop.slice(1))context.lineTo(point.x,point.y);context.closePath();}
    else for(const triangle of triangles){
      const [a,b,c]=triangle.points,positive=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)>=0;
      context.moveTo(a.x,a.y);context.lineTo(positive?b.x:c.x,positive?b.y:c.y);context.lineTo(positive?c.x:b.x,positive?c.y:b.y);context.closePath();
    }
    context.clip();
    for (let i=0;i<triangles.length;) {
      const triangle=triangles[i],group=[triangle];let end=i+1;
      while(end<triangles.length&&triangles[end].matrix.every((value,j)=>Number.isFinite(value)&&Math.abs(value-triangle.matrix[j])*Math.max(scale,1)<=1e-8))group.push(triangles[end++]);
      // A rigid face or weapon may share a mesh with deforming cloth. Keep
      // consecutive faces with the same map in one draw, preserving ordering.
      if(group.length>1){drawAffineGroup(context,group,triangle.matrix,image,false,true,slot);i=end;continue;}
      const [a, b, c] = triangle.clipPoints;
      context.save(); context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.lineTo(c.x, c.y); context.closePath(); context.clip();
      context.transform(...triangle.matrix); drawMeshTexture(context,image,[triangle],slot); context.restore();
      i=end;
    }
    context.restore();
  } else {
    context.save(); context.transform(...slot.matrix); context.scale(1, -1); drawTexture(context,image,-slot.width/2,-slot.height/2,slot.width,slot.height); context.restore();
  }
}
/** Input must have passed validateSkeleton2dDocument at its storage boundary. */
export function sampleSkeleton2d(document, { skin = document.skins[0]?.name, animation = Object.keys(document.animations)[0], time = 0, loop } = {}) {
  if (!Number.isFinite(time)) throw new Error('Skeleton2D sample time must be finite.');
  if (loop !== undefined && typeof loop !== 'boolean') throw new Error('Skeleton2D loop must be boolean.');
  const selectedSkin = document.skins.find(entry=>entry.name===skin);
  if(!selectedSkin) throw new Error(`Unknown Skeleton2D skin ${skin}.`);
  animation=animation === '' ? '' : document.skinAnimations?.[skin]?.[animation] ?? animation;
  const clip=animation === '' ? {} : document.animations[animation]; if(!clip) throw new Error(`Unknown Skeleton2D animation ${animation}.`);
  const duration=animation === '' ? 0 : document.animationDurations[animation], looping=animation === '' ? false : loop ?? (document.loopAnimations ?? []).includes(animation);
  const at=looping ? Math.max(0,time)%duration : Math.min(Math.max(0,time),duration);
  const byName = new Map(), bones=[];
  for(const setup of document.skinBones?.[skin] ?? document.bones) {
    const tracks=clip.bones?.[setup.name] ?? {}, translation=sampleTimeline(tracks.translate,at), rotation=sampleTimeline(tracks.rotate,at), scale=sampleTimeline(tracks.scale,at,1);
    const bone={name:setup.name,parent:setup.parent ?? null,x:(setup.x??0)+(translation?.x??0),y:(setup.y??0)+(translation?.y??0),rotation:(setup.rotation??0)+(rotation?.value??0),scaleX:(setup.scaleX??1)*(scale?.x??1),scaleY:(setup.scaleY??1)*(scale?.y??1)};
    if(setup.rotationLimit!==undefined) bone.rotation=Math.max(-setup.rotationLimit,Math.min(setup.rotationLimit,bone.rotation));
    bone.matrix=matrix(bone.x,bone.y,bone.rotation,bone.scaleX,bone.scaleY);
    if(bone.parent) bone.matrix=multiplyMatrices(byName.get(bone.parent).matrix,bone.matrix);
    byName.set(bone.name,bone);bones.push(bone);
  }
  const drawOrder=orderAt(document.slots,latest(clip.drawOrder,at)?.offsets), slots=[]; let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  const slotMap=new Map(document.slots.map(slot=>[slot.name,slot]));
  for(const slotName of drawOrder) {
    const setup=slotMap.get(slotName), key=latest(clip.slots?.[slotName]?.attachment,at), attachmentName=key===undefined ? setup.attachment : key.name;
    if(attachmentName===null || attachmentName===undefined)continue;
    const attachment=selectedSkin.attachments[slotName]?.[attachmentName]; if(!attachment)continue;
    const m=multiplyMatrices(byName.get(setup.bone).matrix,matrix(attachment.x,attachment.y,attachment.rotation,attachment.scaleX,attachment.scaleY));
    const width=attachment.width,height=attachment.height,vertices=attachment.type === 'mesh' ? weightedVertices(attachment,bones) : [[-width/2,height/2],[width/2,height/2],[width/2,-height/2],[-width/2,-height/2]].map(([x,y])=>transformPoint(m,x,y));
    for(const v of vertices){minX=Math.min(minX,v.x);minY=Math.min(minY,v.y);maxX=Math.max(maxX,v.x);maxY=Math.max(maxY,v.y);}
    slots.push({name:slotName,bone:setup.bone,attachment:attachmentName,region:attachment.path,fileName:document.textures[attachment.path],matrix:m,width,height,vertices,
      ...(attachment.type === 'mesh' ? {type:'mesh',worldVertices:vertices.flatMap(point=>[point.x,point.y]),uvs:attachment.uvs,triangles:attachment.triangles} : {})});
  }
  const socketPoints={};
  for(const [socket,slotName]of Object.entries(document.skinSockets?.[skin]??{})) {
    const setup=slotMap.get(slotName), attachment=selectedSkin.attachments[slotName]?.[setup.attachment ?? 'part']; if(!attachment)continue;
    const rotation=radians(attachment.rotation??0),tip=attachment.tip??{x:(attachment.x??0)-Math.sin(rotation)*attachment.height/2,y:(attachment.y??0)+Math.cos(rotation)*attachment.height/2};
    socketPoints[socket]=transformPoint(byName.get(setup.bone).matrix,tip.x,tip.y);
  }
  const lines=(document.lines??[]).filter(line=>(!line.skin||line.skin===skin)&&slots.some(slot=>slot.name===line.slot&&slot.attachment===line.attachment)).map(line=>({...line,points:line.points.map(point=>transformPoint(byName.get(point.bone).matrix,point.x,point.y))}));
  return {skin,animation,time:at,duration,loop:looping,bones,slots,drawOrder,socketPoints,lines,clipBounds:document.clipBounds?.[animation]??null,
    bounds:Number.isFinite(minX)?{x:minX,y:minY,width:maxX-minX,height:maxY-minY}:null,
    // Events are timeline facts, not callbacks: the caller determines crossings when playing/scrubbing.
    events:(clip.events??[]).filter(event=>(event.time??0)<=at).map(event=>({...document.events?.[event.name],...event}))};
}
