#!/usr/bin/env bash
# Can this machine's IP reach the sites the pipeline scrapes? One GET per site, 2 s apart, with the
# same identified User-Agent the scraper sends. Run it on a trial VM before committing to a
# provider: faculty pages and Vidwan block by IP reputation, so a datacenter IP may get 403s that
# a home connection does not. Needs only curl; no keys, no database, no credits.
#
#   bash deploy/probe-ip.sh            # the default list below
#   bash deploy/probe-ip.sh URL ...    # your own
UA='ClassOneSalesBot/1.0 (+mailto:saiethihaschanda@gmail.com; purpose: academic lead research)'
URLS=("$@")
[[ ${#URLS[@]} -gt 0 ]] || URLS=(
  https://vidwan.inflibnet.ac.in/profiles
  https://chemistry.iitd.ac.in/faculty
  https://www.chem.iitb.ac.in/people/faculty
  https://www.iitk.ac.in/che/faculty
  https://chem.iitm.ac.in/faculty/
  https://www.iitg.ac.in/chem/faculty
  https://iitbhu.ac.in/dept/chy/faculty
  https://chemistry.iiti.ac.in/faculty
  https://www.iitp.ac.in/
  https://www.iitkgp.ac.in/
  https://www.iitbbs.ac.in/
  https://www.iitrpr.ac.in/
  https://www.iitmandi.ac.in/
  https://www.iitjammu.ac.in/
)

echo "Public IP: $(curl -fsS https://api.ipify.org 2>/dev/null || echo unknown)"
ok=0; bad=0
for u in "${URLS[@]}"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -A "$UA" -L --max-time 25 "$u")
  case $code in
    2??) verdict=ok; ok=$((ok+1)) ;;
    403|429|451) verdict="BLOCKED"; bad=$((bad+1)) ;;
    000) verdict="no answer (timeout / dropped)"; bad=$((bad+1)) ;;
    *) verdict="check"; bad=$((bad+1)) ;;
  esac
  printf '%-48s %s  %s\n' "$u" "$code" "$verdict"
  sleep 2
done
echo; echo "$ok reachable, $bad not."
