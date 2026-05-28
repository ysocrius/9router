import React from "react";

export default function WhatsNewPage() {
  // Fetch the changelog at build time (static generation)
  // For simplicity, we embed the latest change manually.
  const changelog = `# v0.4.56-private.1 (2026-05-28)

## Features
- In-app Release Notes: Introduced the new /dashboard/whats-new page to showcase changelogs directly inside the UI.`;

  return (
    <div className="min-h-screen bg-gradient-to-r from-indigo-900 via-purple-900 to-pink-800 p-8 text-white font-sans">
      <h1 className="text-4xl font-extrabold mb-6 text-center animate-fade-in">What’s New</h1>
      <article className="prose prose-invert max-w-3xl mx-auto bg-black bg-opacity-30 rounded-lg p-6 shadow-lg backdrop-blur-md">
        <pre className="whitespace-pre-wrap" style={{ overflowX: "auto" }}>{changelog}</pre>
      </article>
    </div>
  );
}
