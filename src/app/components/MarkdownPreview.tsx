export function MarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <div className="markdown-preview">
      {markdown.split("\n").map((line, index) => {
        if (line.startsWith("# ")) return <h1 key={index}>{line.slice(2)}</h1>;
        if (line.startsWith("## ")) return <h2 key={index}>{line.slice(3)}</h2>;
        if (line.startsWith("- ")) return <p key={index} className="bullet-line">{line.slice(2)}</p>;
        if (!line.trim()) return <br key={index} />;
        return <p key={index}>{line}</p>;
      })}
    </div>
  );
}
