import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The unpacked local Rivet extension has a stable Chrome origin. Keep this
  // exact: vinext blocks all other cross-origin development requests.
  allowedDevOrigins: ["phbofjenfnnnnndghhinoldlfbpaedpo"],
};

export default nextConfig;
