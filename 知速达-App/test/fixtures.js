import { zipSync, strToU8 } from "fflate";

export function docxFixture(body = '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 绪论</w:t></w:r></w:p><w:p><w:r><w:t>心理学研究心理过程与行为。这里是用于验证的自编材料。</w:t></w:r><w:r><w:tab/><w:t>包括可观察行为与心理活动。</w:t></w:r></w:p><w:p><w:del><w:r><w:delText>删除的旧定义不应出现。</w:delText></w:r></w:del><w:r><w:t>保留的新定义。</w:t></w:r></w:p>') {
  return Buffer.from(zipSync({
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
    "word/styles.xml": strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>'),
  }));
}

// 只用于测试的有效 PDF 生成器，含文字页、空白页及正确交叉引用表。
export function pdfFixture(pages = ["Retrieval practice requires recalling information without looking at notes.", "Spaced practice spreads learning over time."]) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids = [];
  for (const text of pages) {
    const stream = text ? `BT /F1 12 Tf 50 750 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET` : "";
    const pageId = objects.length + 1, contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
  let file = "%PDF-1.4\n", offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(file)); file += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(file);
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(offset => { file += `${String(offset).padStart(10, "0")} 00000 n \n`; });
  file += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(file);
}
