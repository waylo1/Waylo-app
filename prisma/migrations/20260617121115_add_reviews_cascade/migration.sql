-- DropForeignKey
ALTER TABLE "Review" DROP CONSTRAINT "Review_missionId_fkey";

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
