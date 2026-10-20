const axios = require('axios');

const axiosNhl = axios.create({
  baseURL: 'https://api-web.nhle.com/v1',
  timeout: 10000,
});
const axiosNhlTeam = axios.create({
  baseURL: 'https://api.nhle.com/stats/rest/en/team',
  timeout: 10000,
});
const axiosNhlStats = axios.create({
  baseURL: 'https://api.nhle.com/stats/rest/en/skater',
  timeout: 10000,
});
const axiosNhlGoalie = axios.create({
  baseURL: 'https://api.nhle.com/stats/rest/en/goalie',
  timeout: 10000,
});

const axiosNhlShifts = axios.create({
  baseURL: 'https://api.nhle.com/stats/rest/en',
  timeout: 10000,
});

module.exports = {
  axiosNhl,
  axiosNhlTeam,
  axiosNhlStats,
  axiosNhlGoalie,
  axiosNhlShifts,
};
