import Link from "next/link";
import { Code2, Package, Zap, ArrowRight } from "lucide-react";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-gray-800">
      {/* Header */}
      <header className="container mx-auto px-6 py-6">
        <nav className="flex items-center justify-between">
          <div className="text-white font-bold text-2xl">Bhai Developers</div>
          <div className="space-x-4">
            <Link href="/login" className="text-gray-300 hover:text-white">
              Sign in
            </Link>
            <Link
              href="/register"
              className="bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700"
            >
              Get Started
            </Link>
          </div>
        </nav>
      </header>

      {/* Hero */}
      <section className="container mx-auto px-6 py-20 text-center">
        <h1 className="text-5xl font-bold text-white mb-6">
          Build for Bhai
        </h1>
        <p className="text-xl text-gray-300 mb-8 max-w-2xl mx-auto">
          Create Skills, MCP Servers, and Tools that extend Bhai capabilities.
          Reach thousands of users through the built-in store.
        </p>
        <div className="flex justify-center space-x-4">
          <Link
            href="/register"
            className="bg-primary-600 text-white px-8 py-3 rounded-lg font-medium hover:bg-primary-700 flex items-center"
          >
            Start Building <ArrowRight className="ml-2 h-5 w-5" />
          </Link>
          <Link
            href="/docs"
            className="bg-gray-700 text-white px-8 py-3 rounded-lg font-medium hover:bg-gray-600"
          >
            Read the Docs
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className="container mx-auto px-6 py-20">
        <div className="grid md:grid-cols-3 gap-8">
          <div className="bg-gray-800 p-8 rounded-xl">
            <div className="bg-primary-600 w-12 h-12 rounded-lg flex items-center justify-center mb-4">
              <Code2 className="h-6 w-6 text-white" />
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">Skills</h3>
            <p className="text-gray-400">
              Create instruction sets that give Bhai new capabilities and knowledge.
              Write in Markdown, no coding required.
            </p>
          </div>

          <div className="bg-gray-800 p-8 rounded-xl">
            <div className="bg-green-600 w-12 h-12 rounded-lg flex items-center justify-center mb-4">
              <Zap className="h-6 w-6 text-white" />
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">MCP Servers</h3>
            <p className="text-gray-400">
              Build Model Context Protocol servers that connect Bhai to external services
              and APIs.
            </p>
          </div>

          <div className="bg-gray-800 p-8 rounded-xl">
            <div className="bg-purple-600 w-12 h-12 rounded-lg flex items-center justify-center mb-4">
              <Package className="h-6 w-6 text-white" />
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">Tools</h3>
            <p className="text-gray-400">
              Create custom tools with TypeScript that Bhai can use to perform
              specific actions.
            </p>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="container mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold text-white text-center mb-12">
          How It Works
        </h2>
        <div className="max-w-3xl mx-auto">
          <div className="flex items-start space-x-4 mb-8">
            <div className="bg-primary-600 text-white w-8 h-8 rounded-full flex items-center justify-center font-bold shrink-0">
              1
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">Register as a Developer</h3>
              <p className="text-gray-400">
                Create your developer account and submit for approval. We review all developers
                to ensure quality.
              </p>
            </div>
          </div>

          <div className="flex items-start space-x-4 mb-8">
            <div className="bg-primary-600 text-white w-8 h-8 rounded-full flex items-center justify-center font-bold shrink-0">
              2
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">Build Your Extension</h3>
              <p className="text-gray-400">
                Use our SDK and documentation to create Skills, MCP Servers, or Tools.
                Test locally with the Bhai dev environment.
              </p>
            </div>
          </div>

          <div className="flex items-start space-x-4 mb-8">
            <div className="bg-primary-600 text-white w-8 h-8 rounded-full flex items-center justify-center font-bold shrink-0">
              3
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">Submit for Review</h3>
              <p className="text-gray-400">
                Upload your extension with a description, screenshots, and icon.
                Our team reviews for quality and security.
              </p>
            </div>
          </div>

          <div className="flex items-start space-x-4">
            <div className="bg-primary-600 text-white w-8 h-8 rounded-full flex items-center justify-center font-bold shrink-0">
              4
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">Reach Users</h3>
              <p className="text-gray-400">
                Once approved, your extension appears in the Bhai Store.
                Users can install with one click.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="container mx-auto px-6 py-8 border-t border-gray-700">
        <div className="flex items-center justify-between text-gray-400">
          <p>&copy; 2024-2026 XAGI Labs Private Limited. All rights reserved.</p>
          <div className="space-x-6">
            <Link href="/docs" className="hover:text-white">Documentation</Link>
            <Link href="/terms" className="hover:text-white">Terms</Link>
            <Link href="/privacy" className="hover:text-white">Privacy</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
